// Soniox (file transcription) and OpenAI (report, Q&A). Same requests, prompts and
// schema as the web backend (server/api.mjs), so both versions produce the same data.
// Everything here blocks: call it off the GTK thread.
use reqwest::blocking::{multipart, Client};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

const SONIOX: &str = "https://api.soniox.com/v1";
const OPENAI: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_SUMMARY_MODEL: &str = "gpt-6-luna";
// USD per 1M tokens (same defaults as the web backend).
const SUMMARY_PRICE_IN: f64 = 0.10;
const SUMMARY_PRICE_OUT: f64 = 0.50;

const REPORT_PROMPT: &str = include_str!("../assets/report_prompt.txt");
const ASK_PROMPT: &str = include_str!("../assets/ask_prompt.txt");
const REPORT_SCHEMA: &str = include_str!("../assets/report_schema.json");
const VOCABULARY: &str = include_str!("../assets/vocabulary.txt");

// ---------- Settings (per-user API keys) ----------

pub type Settings = BTreeMap<String, String>;

pub fn settings_file() -> PathBuf {
    gtk::glib::user_config_dir().join("com.traventia.meeting-recorder").join("settings.json")
}

pub fn read_settings() -> Settings {
    std::fs::read_to_string(settings_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write_settings(settings: &Settings) -> Result<(), String> {
    let file = settings_file();
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

pub fn has_keys() -> bool {
    let s = read_settings();
    ["SONIOX_API_KEY", "OPENAI_API_KEY"].iter().all(|k| s.get(*k).is_some_and(|v| !v.is_empty()))
}

fn key(name: &str) -> Result<String, String> {
    read_settings()
        .get(name)
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or_else(|| format!("Falta {name}: ponla en Ajustes."))
}

fn summary_model() -> String {
    read_settings().get("SUMMARY_MODEL").cloned().unwrap_or_else(|| DEFAULT_SUMMARY_MODEL.into())
}

// ---------- Tokens <-> turns (port of src/lib/turns.js) ----------

const GAP_MS: f64 = 2000.0;

// Groups consecutive tokens from the same speaker into turns (seconds, like the stored format).
pub fn tokens_to_turns(tokens: &[Value]) -> Vec<Value> {
    let mut turns: Vec<(f64, f64, Option<String>, String)> = vec![];
    for token in tokens {
        let text = token["text"].as_str().unwrap_or("");
        if text.is_empty() {
            continue;
        }
        let speaker = token["speaker"]
            .as_str()
            .map(str::to_string)
            .or_else(|| token["speaker"].as_i64().map(|n| n.to_string()))
            .filter(|s| !s.is_empty())
            .map(|s| format!("Hablante {s}"));
        let start = token["start_ms"].as_f64().unwrap_or(0.0);
        let end = token["end_ms"].as_f64().unwrap_or(start);
        match turns.last_mut() {
            Some(last) if last.2 == speaker && start - last.1 * 1000.0 < GAP_MS => {
                last.3.push_str(text);
                last.1 = end / 1000.0;
            }
            _ => turns.push((start / 1000.0, end / 1000.0, speaker, text.trim_start().to_string())),
        }
    }
    turns
        .into_iter()
        .map(|(start, end, speaker, text)| (start, end, speaker, text.trim().to_string()))
        .filter(|t| !t.3.is_empty())
        .map(|(start, end, speaker, text)| json!({ "start": start, "end": end, "speaker": speaker, "text": text }))
        .collect()
}

fn mmss(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    format!("{:02}:{:02}", s / 60, s % 60)
}

pub fn turns_to_text(turns: &[Value]) -> String {
    turns
        .iter()
        .map(|t| {
            let speaker = t["speaker"].as_str().map(|s| format!("{s}: ")).unwrap_or_default();
            format!("[{}] {speaker}{}", mmss(t["start"].as_f64().unwrap_or(0.0)), t["text"].as_str().unwrap_or(""))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// Soniox bills tokens, not minutes (USD per 1M tokens). Same approximation as the web.
pub fn soniox_cost_usd(audio_seconds: f64, output_tokens: usize) -> f64 {
    (audio_seconds * (1000.0 / 120.0) * 1.5 + (output_tokens as f64 + 700.0) * 3.5) / 1e6
}

fn stt_config() -> Value {
    let terms: Vec<&str> = VOCABULARY
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    json!({
        "language_hints": ["es"],
        "enable_speaker_diarization": true,
        "context": {
            "text": "Reunión interna de trabajo del equipo de Traventia, agencia de viajes online española.",
            "terms": terms,
        },
    })
}

fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(b), Value::Object(e)) = (base.as_object_mut(), extra) {
        b.extend(e);
    }
    base
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn build_transcription(recording_id: &str, turns: Vec<Value>, model: &str, cost: f64) -> Value {
    json!({
        "recordingId": recording_id,
        "createdAt": now_iso(),
        "transcript_text": turns_to_text(&turns),
        "speaker_turns": turns,
        "transcription_model": model,
        "estimated_transcription_cost_usd": cost,
    })
}

// ---------- Soniox: whole file ----------

fn http() -> Client {
    Client::builder().timeout(Duration::from_secs(600)).build().expect("http client")
}

fn soniox(client: &Client, req: reqwest::blocking::RequestBuilder) -> Result<Value, String> {
    let _ = client;
    let res = req.send().map_err(|e| format!("Soniox: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Soniox {status}: {}", res.text().unwrap_or_default()));
    }
    if status.as_u16() == 204 {
        return Ok(Value::Null);
    }
    res.json().map_err(|e| format!("Soniox: {e}"))
}

pub fn transcribe_file(path: &Path, recording_id: &str) -> Result<Value, String> {
    let api_key = key("SONIOX_API_KEY")?;
    let client = http();
    let auth = |r: reqwest::blocking::RequestBuilder| r.bearer_auth(&api_key);

    let form = multipart::Form::new()
        .file("file", path)
        .map_err(|e| format!("No se pudo leer el audio: {e}"))?;
    let file_id = soniox(&client, auth(client.post(format!("{SONIOX}/files")).multipart(form)))?["id"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let mut transcription_id = String::new();
    let result = (|| {
        let body = merge(
            stt_config(),
            json!({ "model": "stt-async-v6", "file_id": file_id, "client_reference_id": recording_id }),
        );
        transcription_id = soniox(&client, auth(client.post(format!("{SONIOX}/transcriptions")).json(&body)))?
            ["id"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let job = loop {
            let job = soniox(&client, auth(client.get(format!("{SONIOX}/transcriptions/{transcription_id}"))))?;
            match job["status"].as_str() {
                Some("completed") => break job,
                Some("error") => {
                    return Err(job["error_message"].as_str().unwrap_or("Soniox error").to_string())
                }
                _ => thread::sleep(Duration::from_secs(2)),
            }
        };
        let transcript = soniox(
            &client,
            auth(client.get(format!("{SONIOX}/transcriptions/{transcription_id}/transcript"))),
        )?;
        let tokens = transcript["tokens"].as_array().cloned().unwrap_or_default();
        let audio_seconds = job["audio_duration_ms"].as_f64().unwrap_or(0.0) / 1000.0;
        Ok(build_transcription(
            recording_id,
            tokens_to_turns(&tokens),
            "soniox stt-async-v6",
            soniox_cost_usd(audio_seconds, tokens.len()),
        ))
    })();

    // Don't leave meeting audio stored at the provider.
    if !transcription_id.is_empty() {
        let _ = auth(client.delete(format!("{SONIOX}/transcriptions/{transcription_id}"))).send();
    }
    if !file_id.is_empty() {
        let _ = auth(client.delete(format!("{SONIOX}/files/{file_id}"))).send();
    }
    result
}

// ---------- OpenAI ----------

fn chat_completion(messages: Value, response_format: Option<Value>) -> Result<(String, f64), String> {
    let api_key = key("OPENAI_API_KEY")?;
    let model = summary_model();
    let mut body = json!({ "model": model, "reasoning_effort": "none", "messages": messages });
    if let Some(format) = response_format {
        body["response_format"] = format;
    }
    let res = http()
        .post(OPENAI)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .map_err(|e| format!("OpenAI: {e}"))?;
    let status = res.status();
    let value: Value = res.json().map_err(|e| format!("OpenAI: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI {status}: {}",
            value["error"]["message"].as_str().unwrap_or("error")
        ));
    }
    let content = value["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    let usage = &value["usage"];
    let cost = (usage["prompt_tokens"].as_f64().unwrap_or(0.0) * SUMMARY_PRICE_IN
        + usage["completion_tokens"].as_f64().unwrap_or(0.0) * SUMMARY_PRICE_OUT)
        / 1e6;
    Ok((content, cost))
}

// Returns the transcription with report, report_model, report_cost_usd and report_updated_at.
pub fn add_report(mut transcription: Value) -> Result<Value, String> {
    let turns = transcription["speaker_turns"].as_array().cloned().unwrap_or_default();
    let text = turns_to_text(&turns);
    if text.trim().is_empty() {
        return Err("La transcripción está vacía: no hay nada que resumir.".into());
    }
    let schema: Value = serde_json::from_str(REPORT_SCHEMA).expect("report schema");
    let (content, cost) = chat_completion(
        json!([
            { "role": "system", "content": REPORT_PROMPT },
            { "role": "user", "content": text },
        ]),
        Some(json!({
            "type": "json_schema",
            "json_schema": { "name": "meeting_report", "strict": true, "schema": schema },
        })),
    )?;
    let report: Value = serde_json::from_str(&content).map_err(|e| format!("Acta inválida: {e}"))?;
    let map: &mut Map<String, Value> = transcription.as_object_mut().ok_or("transcripción inválida")?;
    map.insert("report".into(), report);
    map.insert("report_model".into(), json!(summary_model()));
    map.insert("report_cost_usd".into(), json!(cost));
    map.insert("report_updated_at".into(), json!(now_iso()));
    Ok(transcription)
}

// Q&A over one meeting; returns the chat with the new question and answer appended.
pub fn ask(transcription: &Value, chat: &Value, question: &str) -> Result<Value, String> {
    let report = &transcription["report"];
    let names: Vec<String> = report["participants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["name"].as_str().is_some_and(|n| !n.is_empty()))
        .map(|p| format!("{} = {}", p["speaker"].as_str().unwrap_or(""), p["name"].as_str().unwrap_or("")))
        .collect();
    let turns = transcription["speaker_turns"].as_array().cloned().unwrap_or_default();
    let transcript = {
        let t = turns_to_text(&turns);
        if t.is_empty() { transcription["transcript_text"].as_str().unwrap_or("").to_string() } else { t }
    };
    let mut context = vec![];
    if !names.is_empty() {
        context.push(format!("Hablantes identificados: {}", names.join(", ")));
    }
    if let Some(summary) = report["summary"].as_str().filter(|s| !s.is_empty()) {
        context.push(format!("Resumen:\n{summary}"));
    }
    context.push(format!("Transcripción:\n{transcript}"));

    let (answer, cost) = chat_completion(
        json!([
            { "role": "system", "content": format!("{ASK_PROMPT}\n\n{}", context.join("\n\n")) },
            { "role": "user", "content": question },
        ]),
        None,
    )?;
    let now = now_iso();
    let mut next = chat.as_array().cloned().unwrap_or_default();
    next.push(json!({ "role": "user", "content": question, "createdAt": now }));
    next.push(json!({ "role": "assistant", "content": answer, "createdAt": now, "cost_usd": cost }));
    Ok(Value::Array(next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_tokens_by_speaker_and_gap() {
        let tokens = vec![
            json!({ "text": " Hola", "speaker": "1", "start_ms": 0, "end_ms": 500 }),
            json!({ "text": " qué tal", "speaker": "1", "start_ms": 600, "end_ms": 1200 }),
            json!({ "text": " Bien", "speaker": "2", "start_ms": 1300, "end_ms": 1600 }),
            json!({ "text": " otra", "speaker": "2", "start_ms": 5000, "end_ms": 5400 }),
        ];
        let turns = tokens_to_turns(&tokens);
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0]["text"], "Hola qué tal");
        assert_eq!(turns[0]["speaker"], "Hablante 1");
        assert_eq!(turns_to_text(&turns[..1]), "[00:00] Hablante 1: Hola qué tal");
    }
}

// Real API round trip (costs < 1 cent). MR_TEST_AUDIO=<webm> cargo test -- --ignored api_
#[cfg(test)]
mod api_tests {
    use super::*;

    #[test]
    #[ignore]
    fn api_file_report_and_ask() {
        let audio = std::env::var("MR_TEST_AUDIO").expect("MR_TEST_AUDIO");
        let t = transcribe_file(Path::new(&audio), "test-native-app").unwrap();
        println!("file turns: {}", t["speaker_turns"]);
        let t = add_report(t).unwrap();
        println!("title: {}", t["report"]["meeting_title"]);
        let chat = ask(&t, &json!([]), "¿De qué se habla?").unwrap();
        println!("answer: {}", chat[1]["content"]);
    }
}
