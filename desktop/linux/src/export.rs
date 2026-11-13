// Downloads: original audio, meeting notes (.md) and a zip with audio + notes + transcript.
use crate::db::Recording;
use crate::{clock, speaker_names, strings};
use chrono::{DateTime, Local};
use serde_json::Value;
use std::{fs::File, io::Write, path::Path};

pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(80).collect();
    if out.is_empty() { "reunion".into() } else { out.trim_end_matches('-').to_string() }
}

pub fn base_name(recording: &Recording) -> String {
    slug(&recording.title())
}

// "[mm:ss] Name: text" per turn, names from the report when known.
pub fn transcript_lines(recording: &Recording, bold: bool) -> Vec<String> {
    let names = speaker_names(recording.report());
    recording
        .transcription
        .as_ref()
        .and_then(|t| t["speaker_turns"].as_array())
        .map(|turns| {
            turns
                .iter()
                .map(|turn| {
                    let speaker = turn["speaker"].as_str().unwrap_or("");
                    let who = names.iter().find(|(s, _)| s == speaker).map(|(_, n)| n.as_str()).unwrap_or(speaker);
                    let time = clock(turn["start"].as_f64().unwrap_or(0.0));
                    let text = turn["text"].as_str().unwrap_or("").trim();
                    if bold { format!("**[{time}] {who}:** {text}") } else { format!("[{time}] {who}: {text}") }
                })
                .collect()
        })
        .unwrap_or_default()
}

// Same layout as the web's buildMeetingMarkdown.
pub fn meeting_markdown(recording: &Recording) -> String {
    let report = recording.report().cloned().unwrap_or(Value::Null);
    let mut summary: Vec<String> = vec![];
    let push_list = |out: &mut Vec<String>, title: &str, items: Vec<String>| {
        if !items.is_empty() {
            out.push(format!("{title}:"));
            out.extend(items.into_iter().map(|i| format!("- {i}")));
            out.push(String::new());
        }
    };
    if let Some(t) = report["meeting_title"].as_str().filter(|t| !t.is_empty()) {
        summary.extend([format!("Título: {t}"), String::new()]);
    }
    if let Some(t) = report["summary"].as_str().filter(|t| !t.is_empty()) {
        summary.extend(["Resumen ejecutivo:".to_string(), t.to_string(), String::new()]);
    }
    let participants: Vec<String> = report["participants"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let speaker = p["speaker"].as_str().unwrap_or("");
            let name = p["name"].as_str().unwrap_or("");
            let role = p["role"].as_str().unwrap_or("");
            let who = if name.is_empty() { speaker.to_string() } else { format!("{name} ({speaker})") };
            if role.is_empty() { who } else { format!("{who}: {role}") }
        })
        .collect();
    push_list(&mut summary, "Participantes", participants);
    push_list(&mut summary, "Puntos clave", strings(&report["key_points"]));
    if let Some(topics) = report["topics"].as_array().filter(|t| !t.is_empty()) {
        summary.push("Temas tratados:".into());
        for (i, t) in topics.iter().enumerate() {
            let title = t["title"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
            summary.push(format!("- {}", title.unwrap_or(format!("Tema {}", i + 1))));
            if let Some(s) = t["summary"].as_str().filter(|s| !s.is_empty()) {
                summary.push(format!("  {s}"));
            }
            if let Some(h) = t["start_time_hint"].as_str().filter(|s| !s.is_empty()) {
                summary.push(format!("  Inicio aprox.: {h}"));
            }
        }
        summary.push(String::new());
    }
    push_list(&mut summary, "Decisiones", strings(&report["decisions"]));
    let tasks: Vec<String> = report["action_items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            let mut line = a["task"].as_str().filter(|s| !s.is_empty()).unwrap_or("Tarea").to_string();
            if let Some(o) = a["owner"].as_str().filter(|s| !s.is_empty()) {
                line += &format!(" | Responsable: {o}");
            }
            if let Some(d) = a["due_date"].as_str().filter(|s| !s.is_empty()) {
                line += &format!(" | Fecha: {d}");
            }
            line
        })
        .collect();
    push_list(&mut summary, "Tareas", tasks);
    push_list(&mut summary, "Riesgos", strings(&report["risks"]));
    push_list(&mut summary, "Preguntas abiertas", strings(&report["open_questions"]));

    let date = DateTime::parse_from_rfc3339(recording.created_at())
        .map(|d| d.with_timezone(&Local).format("%d/%m/%y, %H:%M:%S").to_string())
        .unwrap_or_default();
    [
        format!("# {}", recording.title()),
        format!("{date} · {}", clock(recording.duration_seconds())),
        "## Resumen".into(),
        summary.join("\n").trim().to_string(),
        "## Transcripción".into(),
        transcript_lines(recording, true).join("\n\n"),
    ]
    .join("\n\n")
}

// Zip: <base>.webm (stored, already compressed) + <base>-acta.md + <base>-transcripcion.txt.
pub fn write_zip(dest: &Path, base: &str, audio: &Path, notes: Option<String>, transcript: Option<String>) -> Result<(), String> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(File::create(dest).map_err(|e| e.to_string())?);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(format!("{base}.webm"), stored).map_err(|e| e.to_string())?;
    std::io::copy(&mut File::open(audio).map_err(|e| e.to_string())?, &mut zip).map_err(|e| e.to_string())?;
    if let Some(md) = notes {
        zip.start_file(format!("{base}-acta.md"), deflated).map_err(|e| e.to_string())?;
        zip.write_all(md.as_bytes()).map_err(|e| e.to_string())?;
    }
    if let Some(txt) = transcript {
        zip.start_file(format!("{base}-transcripcion.txt"), deflated).map_err(|e| e.to_string())?;
        zip.write_all(txt.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_strips_accents_and_symbols() {
        assert_eq!(slug("Diseño del chat: ¿emergencias?"), "diseno-del-chat-emergencias");
        assert_eq!(slug("¡!"), "reunion");
    }

    #[test]
    fn zip_contains_the_three_files() {
        let dir = std::env::temp_dir().join("grabador-zip-test");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("a.webm");
        std::fs::write(&audio, b"fake audio").unwrap();
        let dest = dir.join("out.zip");
        write_zip(&dest, "reunion", &audio, Some("# acta".into()), Some("[00:00] x".into())).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        assert_eq!(names, ["reunion.webm", "reunion-acta.md", "reunion-transcripcion.txt"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
