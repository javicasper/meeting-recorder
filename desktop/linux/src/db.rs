// Same storage as the web/Tauri versions: SQLite (metadata, transcription, chat as JSON)
// plus one media file per recording, in the app data dir.
use rusqlite::Connection;
use serde_json::Value;
use std::path::PathBuf;

pub struct Recording {
    pub id: String,
    pub meta: Value,
    pub transcription: Option<Value>,
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
        db.prepare("SELECT id, meta, transcription FROM recordings ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], |row| {
        let meta: String = row.get(1)?;
        let transcription: Option<String> = row.get(2)?;
        Ok(Recording {
            id: row.get(0)?,
            meta: serde_json::from_str(&meta).unwrap_or(Value::Null),
            transcription: transcription.and_then(|t| serde_json::from_str(&t).ok()),
        })
    })?;
    rows.collect()
}
