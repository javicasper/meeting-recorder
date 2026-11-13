// Native capture with ffmpeg from PulseAudio/PipeWire: default mic + whatever plays on the
// default output (its monitor). No pickers, no virtual devices.
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::Sender,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MONO: &str = "aresample=48000:async=1,aformat=channel_layouts=mono";

pub struct Recorder {
    dir: PathBuf,
    mic: bool,
    pc: bool,
    // 16 kHz s16le mono PCM for live transcription.
    live: Option<Sender<Vec<u8>>>,
    // Pause = close the current segment; finish = concat all segments into one file.
    segments: Vec<PathBuf>,
    child: Option<Child>,
}

// File: stereo with mic left / PC right when both are on (same layout as the web app),
// mono otherwise. Live: mono mix on stdout.
fn filter_graph(mic: bool, pc: bool, live: bool) -> String {
    if mic && pc {
        let graph = if live {
            "[0:a]MONO,asplit[m1][m2];[1:a]MONO,asplit[p1][p2];[m1][p1]join=inputs=2:channel_layout=stereo[file];[m2][p2]amix=inputs=2:normalize=0[live]"
        } else {
            "[0:a]MONO[m1];[1:a]MONO[p1];[m1][p1]join=inputs=2:channel_layout=stereo[file]"
        };
        graph.replace("MONO", MONO)
    } else if live {
        format!("[0:a]{MONO},asplit[file][live]")
    } else {
        format!("[0:a]{MONO}[file]")
    }
}

fn read_stderr(child: &mut Child) -> String {
    let mut text = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut text);
    }
    text.trim().to_string()
}

impl Recorder {
    pub fn start(mic: bool, pc: bool, live: Option<Sender<Vec<u8>>>) -> Result<Self, String> {
        if !mic && !pc {
            return Err("Elige al menos el micro o el audio del PC.".into());
        }
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let dir = std::env::temp_dir().join(format!("grabador-reuniones-{stamp}"));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut recorder = Recorder { dir, mic, pc, live, segments: vec![], child: None };
        recorder.spawn_segment()?;
        Ok(recorder)
    }

    pub fn is_stereo(&self) -> bool {
        self.mic && self.pc
    }

    fn spawn_segment(&mut self) -> Result<(), String> {
        let path = self.dir.join(format!("segment-{}.webm", self.segments.len()));
        let live = self.live.is_some();
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
        if self.mic {
            cmd.args(["-f", "pulse", "-i", "default"]);
        }
        if self.pc {
            cmd.args(["-f", "pulse", "-i", "@DEFAULT_MONITOR@"]);
        }
        cmd.args(["-filter_complex", &filter_graph(self.mic, self.pc, live)]);
        cmd.args(["-map", "[file]", "-c:a", "libopus", "-b:a", "64k"]).arg(&path);
        if live {
            cmd.args(["-map", "[live]", "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"]);
        }
        cmd.stdin(Stdio::piped())
            .stdout(if live { Stdio::piped() } else { Stdio::null() })
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("No se pudo lanzar ffmpeg (¿está instalado?): {e}"))?;
        // Bad device / filter errors show up right away.
        thread::sleep(Duration::from_millis(300));
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err(format!("ffmpeg no arrancó: {}", read_stderr(&mut child)));
        }
        if let (Some(mut out), Some(tx)) = (child.stdout.take(), self.live.clone()) {
            thread::spawn(move || {
                let mut buf = [0u8; 3200]; // 100 ms of 16 kHz s16le mono
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
        }
        self.segments.push(path);
        self.child = Some(child);
        Ok(())
    }

    // "q" makes ffmpeg finish the webm cleanly (a kill would leave it without an index).
    fn finish_segment(&mut self) -> Result<(), String> {
        let Some(mut child) = self.child.take() else { return Ok(()) };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q");
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("ffmpeg terminó con error: {}", read_stderr(&mut child)));
        }
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), String> {
        self.finish_segment()
    }

    pub fn resume(&mut self) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        self.spawn_segment()
    }

    // Blocking: run it off the UI thread. Moves the final webm to `dest`.
    pub fn finish(mut self, dest: &Path) -> Result<u64, String> {
        self.finish_segment()?;
        let output = if self.segments.len() == 1 {
            self.segments[0].clone()
        } else {
            let list = self.dir.join("segments.txt");
            let entries: String =
                self.segments.iter().map(|p| format!("file '{}'\n", p.display())).collect();
            fs::write(&list, entries).map_err(|e| e.to_string())?;
            let output = self.dir.join("recording.webm");
            let status = Command::new("ffmpeg")
                .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
                .arg(&list)
                .args(["-c", "copy"])
                .arg(&output)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(format!(
                    "No se pudieron unir los tramos (están en {}).",
                    self.dir.display()
                ));
            }
            output
        };
        // Copy, not rename: /tmp is often another filesystem.
        let size = fs::copy(&output, dest).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&self.dir);
        Ok(size)
    }
}

// Closing the app mid-recording must not leave ffmpeg running.
impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.finish_segment();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Needs a running PipeWire/PulseAudio: cargo test -- --ignored
    #[test]
    #[ignore]
    fn records_with_pause_and_joins_segments() {
        let mut r = Recorder::start(true, true, None).unwrap();
        thread::sleep(Duration::from_millis(1500));
        r.pause().unwrap();
        thread::sleep(Duration::from_millis(500));
        r.resume().unwrap();
        thread::sleep(Duration::from_millis(1500));
        let dest = std::env::temp_dir().join("grabador-test.webm");
        assert!(r.finish(&dest).unwrap() > 0);
        let probe = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration:stream=channels", "-of", "csv=p=0"])
            .arg(&dest)
            .output()
            .unwrap();
        let out = String::from_utf8_lossy(&probe.stdout);
        let duration: f64 = out.lines().last().unwrap().trim().parse().unwrap();
        assert!(out.lines().next().unwrap().trim() == "2", "expected stereo: {out}");
        assert!((2.5..4.5).contains(&duration), "duration {duration}");
        fs::remove_file(dest).unwrap();
    }
}
