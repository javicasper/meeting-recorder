// Same storage as the web/Tauri versions: SQLite (metadata, transcription, chat as JSON)
// plus one media file per recording, in the app data dir.
use rusqlite::Connection;
use serde_json::Value;
use std::path::PathBuf;

pub struct Recording {
    pub id: String,
    pub meta: Value,
    pub transcription: Option<Value>,
    pub chat: Value,
}

impl Recording {
    pub fn title(&self) -> String {
        let display = self.meta["displayTitle"].as_str().unwrap_or("").trim();
        if display.is_empty() {
            self.meta["name"].as_str().unwrap_or(&self.id).to_string()
        } else {
            display.to_string()
        }
    }

    pub fn created_at(&self) -> &str {
        self.meta["createdAt"].as_str().unwrap_or("")
    }

    pub fn duration_seconds(&self) -> f64 {
        self.meta["durationSeconds"].as_f64().unwrap_or(0.0)
    }

    pub fn media_path(&self) -> PathBuf {
        data_dir().join("media").join(&self.id)
    }

    pub fn report(&self) -> Option<&Value> {
        self.transcription.as_ref()?.get("report").filter(|r| r.is_object())
    }
}

pub fn data_dir() -> PathBuf {
    gtk::glib::user_data_dir().join("com.traventia.meeting-recorder")
}

pub fn open() -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(data_dir().join("media")).ok();
    let db = Connection::open(data_dir().join("meetings.db"))?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS recordings (
           id TEXT PRIMARY KEY,
           created_at TEXT NOT NULL,
           meta TEXT NOT NULL,
           transcription TEXT,
           chat TEXT NOT NULL DEFAULT '[]'
         )",
    )?;
    Ok(db)
}

// Newest first, like the web list.
pub fn load_all(db: &Connection) -> rusqlite::Result<Vec<Recording>> {
    let mut stmt =
        db.prepare("SELECT id, meta, transcription, chat FROM recordings ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], |row| {
        let meta: String = row.get(1)?;
        let transcription: Option<String> = row.get(2)?;
        Ok(Recording {
            id: row.get(0)?,
            meta: serde_json::from_str(&meta).unwrap_or(Value::Null),
            transcription: transcription.and_then(|t| serde_json::from_str(&t).ok()),
            chat: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or(Value::Array(vec![])),
        })
    })?;
    rows.collect()
}

pub fn insert(db: &Connection, id: &str, created_at: &str, meta: &Value) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO recordings (id, created_at, meta) VALUES (?1, ?2, ?3)",
        (id, created_at, meta.to_string()),
    )?;
    Ok(())
}

// Same id format as the browser app: `<epoch ms>-<6 base36 chars>`.
pub fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let mut n = (ms as u64) ^ (std::process::id() as u64).rotate_left(17);
    let suffix: String = (0..6)
        .map(|_| {
            n = n.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            std::char::from_digit(((n >> 33) % 36) as u32, 36).unwrap()
        })
        .collect();
    format!("{ms}-{suffix}")
}

pub fn set_transcription(id: &str, transcription: &Value) -> rusqlite::Result<()> {
    open()?.execute(
        "UPDATE recordings SET transcription = ?1 WHERE id = ?2",
        (transcription.to_string(), id),
    )?;
    Ok(())
}

pub fn set_chat(id: &str, chat: &Value) -> rusqlite::Result<()> {
    open()?.execute("UPDATE recordings SET chat = ?1 WHERE id = ?2", (chat.to_string(), id))?;
    Ok(())
}

pub fn set_title(id: &str, title: &str) -> rusqlite::Result<()> {
    open()?.execute(
        "UPDATE recordings SET meta = json_set(meta, '$.displayTitle', ?1) WHERE id = ?2",
        (title, id),
    )?;
    Ok(())
}

// Also removes its transcription, chat and media file.
pub fn delete(id: &str) -> rusqlite::Result<()> {
    open()?.execute("DELETE FROM recordings WHERE id = ?1", [id])?;
    let _ = std::fs::remove_file(data_dir().join("media").join(id));
    Ok(())
}
