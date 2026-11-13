// Desktop shell for the meeting recorder: runs the Node backend (server/api.mjs, which also
// serves the built UI from dist/) with its own data dir, shows it in a window, and records natively with ffmpeg from PulseAudio/PipeWire — the default mic plus whatever
// plays on the default output — so there is no share picker and no virtual devices.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{Channel, Response},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

// Not 8787, so it can run next to the docker setup while both exist.
const API_PORT: u16 = 8790;
// Dev builds (cargo build) run the backend straight from desktop/ (server/ + dist/).
const REPO_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

struct Backend {
    // Bundled backend (server/, src/lib/, dist/, node_modules/) or the repo in dev.
    dir: PathBuf,
    // Bundled Node next to our binary, or the system one in dev.
    node: PathBuf,
    data_dir: PathBuf,
    settings_file: PathBuf,
    child: Option<Child>,
}

static BACKEND: Mutex<Option<Backend>> = Mutex::new(None);

type Settings = BTreeMap<String, String>;

fn read_settings(file: &Path) -> Settings {
    fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn spawn_backend(b: &mut Backend) -> Result<(), String> {
    if let Some(mut old) = b.child.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let child = Command::new(&b.node)
        .current_dir(&b.dir)
        .arg("server/api.mjs")
        .envs(read_settings(&b.settings_file))
        .env("API_PORT", API_PORT.to_string())
        .env("MEETINGS_DATA_DIR", &b.data_dir)
        .env("EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo arrancar el backend ({}): {e}", b.node.display()))?;
    b.child = Some(child);
    for _ in 0..150 {
        if std::net::TcpStream::connect(("127.0.0.1", API_PORT)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("El backend no respondió en 15 s.".into())
}

fn start_backend(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let bundled = app.path().resource_dir()?.join("backend");
    let dir = if bundled.join("server/api.mjs").exists() { bundled } else { PathBuf::from(REPO_DIR) };
    let sidecar = std::env::current_exe()?.with_file_name("node");
    let node = if sidecar.exists() { sidecar } else { PathBuf::from("node") };
    let data_dir = app.path().app_data_dir()?;
    let config_dir = app.path().app_config_dir()?;
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&config_dir)?;
    let mut backend = Backend {
        dir,
        node,
        data_dir,
        settings_file: config_dir.join("settings.json"),
        child: None,
    };
    spawn_backend(&mut backend)?;
    *BACKEND.lock().unwrap() = Some(backend);
    Ok(())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    let guard = BACKEND.lock().unwrap();
    Ok(guard.as_ref().map(|b| read_settings(&b.settings_file)).unwrap_or_default())
}

// API keys are per user: stored in the app's config dir (owner-only), passed to the backend as env.
#[tauri::command(async)]
fn save_settings(settings: Settings) -> Result<(), String> {
    let mut guard = BACKEND.lock().unwrap();
    let backend = guard.as_mut().ok_or("El backend no está arrancado.")?;
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&backend.settings_file, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&backend.settings_file, fs::Permissions::from_mode(0o600));
    }
    spawn_backend(backend)
}

struct Session {
    dir: PathBuf,
    mic: bool,
    pc: bool,
    live: Option<Channel<Vec<u8>>>,
    // Pause = close the current segment; stop = concat all segments into one file.
    segments: Vec<PathBuf>,
    child: Option<Child>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

const MONO: &str = "aresample=48000:async=1,aformat=channel_layouts=mono";

// File: stereo with mic left / PC right when both are on (same layout as the web app),
// mono otherwise. Live: 16 kHz mono PCM mix on stdout for Soniox.
fn filter_graph(mic: bool, pc: bool, live: bool) -> String {
    if mic && pc {
        let mix = if live {
            "[0:a]MONO,asplit[m1][m2];[1:a]MONO,asplit[p1][p2];[m1][p1]join=inputs=2:channel_layout=stereo[file];[m2][p2]amix=inputs=2:normalize=0[live]"
        } else {
            "[0:a]MONO[m1];[1:a]MONO[p1];[m1][p1]join=inputs=2:channel_layout=stereo[file]"
        };
        mix.replace("MONO", MONO)
    } else if live {
        format!("[0:a]{MONO},asplit[file][live]")
    } else {
        format!("[0:a]{MONO}[file]")
    }
}

fn spawn_segment(s: &mut Session) -> Result<(), String> {
    let path = s.dir.join(format!("segment-{}.webm", s.segments.len()));
    let live = s.live.is_some();
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    if s.mic {
        cmd.args(["-f", "pulse", "-i", "default"]);
    }
    if s.pc {
        cmd.args(["-f", "pulse", "-i", "@DEFAULT_MONITOR@"]);
    }
    cmd.args(["-filter_complex", &filter_graph(s.mic, s.pc, live)]);
    cmd.args(["-map", "[file]", "-c:a", "libopus", "-b:a", "64k"]).arg(&path);
    if live {
        cmd.args(["-map", "[live]", "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"]);
    }
    cmd.stdin(Stdio::piped())
        .stdout(if live { Stdio::piped() } else { Stdio::null() })
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("No se pudo lanzar ffmpeg: {e}"))?;
    // Bad device / filter errors show up right away.
    thread::sleep(Duration::from_millis(300));
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Err(format!("ffmpeg no arrancó: {}", read_stderr(&mut child)));
    }
    if let (Some(mut out), Some(channel)) = (child.stdout.take(), s.live.clone()) {
        thread::spawn(move || {
            let mut buf = [0u8; 3200]; // 100 ms of 16 kHz s16le mono
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 || channel.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    s.segments.push(path);
    s.child = Some(child);
    Ok(())
}

fn read_stderr(child: &mut Child) -> String {
    let mut text = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut text);
    }
    text.trim().to_string()
}

// "q" makes ffmpeg finish the webm cleanly (a kill would leave it without an index).
fn finish_segment(s: &mut Session) -> Result<(), String> {
    let Some(mut child) = s.child.take() else { return Ok(()) };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q");
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("ffmpeg terminó con error: {}", read_stderr(&mut child)));
    }
    Ok(())
}

fn with_session<T>(f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let mut guard = SESSION.lock().unwrap();
    let session = guard.as_mut().ok_or("No hay ninguna grabación en curso.")?;
    f(session)
}

#[tauri::command(async)]
fn start_recording(
    mic: bool,
    pc: bool,
    live: bool,
    on_audio: Channel<Vec<u8>>,
) -> Result<(), String> {
    if !mic && !pc {
        return Err("Marca al menos una fuente de audio.".into());
    }
    let mut guard = SESSION.lock().unwrap();
    if guard.is_some() {
        return Err("Ya hay una grabación en curso.".into());
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let dir = std::env::temp_dir().join(format!("meeting-recorder-{stamp}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let live = live.then_some(on_audio);
    let mut session = Session { dir, mic, pc, live, segments: vec![], child: None };
    spawn_segment(&mut session)?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command(async)]
fn pause_recording() -> Result<(), String> {
    with_session(finish_segment)
}

#[tauri::command(async)]
fn resume_recording() -> Result<(), String> {
    with_session(|s| if s.child.is_some() { Ok(()) } else { spawn_segment(s) })
}

// Returns the finished webm as raw bytes (ArrayBuffer on the JS side).
#[tauri::command(async)]
fn stop_recording() -> Result<Response, String> {
    let mut session = SESSION.lock().unwrap().take().ok_or("No hay ninguna grabación en curso.")?;
    let result = (|| {
        finish_segment(&mut session)?;
        let output = if session.segments.len() == 1 {
            session.segments[0].clone()
        } else {
            let list = session.dir.join("segments.txt");
            let entries: String =
                session.segments.iter().map(|p| format!("file '{}'\n", p.display())).collect();
            fs::write(&list, entries).map_err(|e| e.to_string())?;
            let output = session.dir.join("recording.webm");
            let status = Command::new("ffmpeg")
                .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
                .arg(&list)
                .args(["-c", "copy"])
                .arg(&output)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("No se pudieron unir los tramos de la grabación.".into());
            }
            output
        };
        fs::read(&output).map_err(|e| e.to_string())
    })();
    // Keep the segments on disk if something failed, so the audio can be recovered by hand.
    match result {
        Ok(bytes) => {
            let _ = fs::remove_dir_all(&session.dir);
            Ok(Response::new(bytes))
        }
        Err(e) => Err(format!("{e} (tramos en {})", session.dir.display())),
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            start_backend(app)?;
            let url = format!("http://localhost:{API_PORT}").parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Grabador de reuniones")
                .inner_size(1200.0, 860.0)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            pause_recording,
            resume_recording,
            stop_recording,
            get_settings,
            save_settings
        ])
        .build(tauri::generate_context!())
        .expect("error building the app")
        .run(|_, event| {
            // Don't leave ffmpeg or the backend running after the window closes.
            if let tauri::RunEvent::Exit = event {
                if let Some(mut s) = SESSION.lock().unwrap().take() {
                    let _ = finish_segment(&mut s);
                }
                if let Some(mut child) = BACKEND.lock().unwrap().take().and_then(|b| b.child) {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
