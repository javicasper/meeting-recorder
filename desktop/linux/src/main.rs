// Native Linux app (GTK4 + libadwaita) for the meeting recorder.
mod db;
mod recorder;

use adw::prelude::*;
use chrono::{DateTime, Local};
use db::Recording;
use recorder::Recorder;
use gtk::{glib, Orientation};
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

const APP_ID: &str = "com.traventia.meeting-recorder";

fn main() -> glib::ExitCode {
    let app = adw::Application::builder().application_id(APP_ID).build();
    app.connect_startup(|_| load_brand_css());
    app.connect_activate(build_window);
    app.run()
}

// Dark-mode tweaks keyed on a window class (the logo goes white, like the web).
fn follow_dark_mode(window: &adw::ApplicationWindow) {
    let style = adw::StyleManager::default();
    let apply = {
        let window = window.clone();
        move |style: &adw::StyleManager| {
            if style.is_dark() {
                window.add_css_class("brand-dark");
            } else {
                window.remove_css_class("brand-dark");
            }
        }
    };
    apply(&style);
    style.connect_dark_notify(apply);
}

fn load_brand_css() {
    // libadwaita's symbolic icons come from Adwaita; the desktop theme (e.g. Breeze) lacks many.
    if let Some(settings) = gtk::Settings::default() {
        settings.set_gtk_icon_theme_name(Some("Adwaita"));
    }
    let css = gtk::CssProvider::new();
    css.load_from_string(include_str!("../assets/style.css"));
    gtk::style_context_add_provider_for_display(
        &gtk::gdk::Display::default().expect("no display"),
        &css,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
}

// Traventia logo + "MEETINGS" tag, as in the web header.
fn brand() -> gtk::Widget {
    // Rendered at header size (SVG natural size is 380px wide).
    let svg = glib::Bytes::from_static(include_bytes!("../assets/traventia-logo.svg"));
    let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_stream_at_scale(
        &gtk::gio::MemoryInputStream::from_bytes(&svg),
        -1,
        22,
        true,
        gtk::gio::Cancellable::NONE,
    )
    .expect("logo");
    #[allow(deprecated)]
    let logo = gtk::Picture::for_paintable(&gtk::gdk::Texture::for_pixbuf(&pixbuf));
    logo.set_can_shrink(false);
    logo.add_css_class("brand-logo");
    let tag = gtk::Label::new(Some("MEETINGS"));
    tag.add_css_class("meetings-tag");
    tag.set_valign(gtk::Align::Center);
    let row = gtk::Box::new(Orientation::Horizontal, 8);
    row.append(&logo);
    row.append(&tag);
    row.upcast()
}

fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

fn local_date(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|d| d.with_timezone(&Local).format("%d/%m/%y %H:%M").to_string())
        .unwrap_or_default()
}

// Window state shared by the callbacks (GTK main thread only).
struct Ui {
    recordings: RefCell<Vec<Recording>>,
    list: gtk::ListBox,
    detail: adw::Clamp,
    content: adw::NavigationPage,
    split: adw::NavigationSplitView,
    toasts: adw::ToastOverlay,
}

impl Ui {
    fn toast(&self, message: &str) {
        self.toasts.add_toast(adw::Toast::builder().title(message).timeout(6).build());
    }

    // Re-reads the database and rebuilds the list; selects `select_id` if given.
    fn reload(&self, select_id: Option<&str>) {
        let recordings = db::open().and_then(|conn| db::load_all(&conn)).unwrap_or_else(|e| {
            self.toast(&format!("No se pudo leer la base de datos: {e}"));
            vec![]
        });
        self.list.remove_all();
        for recording in &recordings {
            let row = adw::ActionRow::builder()
                .title(glib::markup_escape_text(&recording.title()))
                .subtitle(format!(
                    "{} · {}",
                    local_date(recording.created_at()),
                    clock(recording.duration_seconds())
                ))
                .build();
            if recording.report().is_some() {
                row.add_suffix(&gtk::Image::from_icon_name("x-office-document-symbolic"));
            }
            self.list.append(&row);
        }
        let index = select_id.and_then(|id| recordings.iter().position(|r| r.id == id));
        *self.recordings.borrow_mut() = recordings;
        if let Some(row) = index.and_then(|i| self.list.row_at_index(i as i32)) {
            self.list.select_row(Some(&row));
        }
    }

    fn show(&self, index: usize) {
        let recordings = self.recordings.borrow();
        let Some(recording) = recordings.get(index) else { return };
        self.content.set_title(&recording.title());
        self.detail.set_child(Some(&recording_detail(recording)));
        self.split.set_show_content(true);
    }
}

fn build_window(app: &adw::Application) {
    let list = gtk::ListBox::builder().css_classes(["navigation-sidebar"]).build();

    let detail = adw::Clamp::builder().maximum_size(860).build();
    detail.set_child(Some(&placeholder()));
    let content_view = adw::ToolbarView::new();
    content_view.add_top_bar(&adw::HeaderBar::new());
    content_view.set_content(Some(
        &gtk::ScrolledWindow::builder().child(&detail).vexpand(true).build(),
    ));
    let content = adw::NavigationPage::new(&content_view, "Reunión");

    let sidebar_view = adw::ToolbarView::new();
    let sidebar_header = adw::HeaderBar::new();
    sidebar_header.set_title_widget(Some(&brand()));
    sidebar_view.add_top_bar(&sidebar_header);
    sidebar_view.set_content(Some(&gtk::ScrolledWindow::builder().child(&list).vexpand(true).build()));
    let sidebar = adw::NavigationPage::new(&sidebar_view, "Reuniones");

    let split = adw::NavigationSplitView::builder()
        .sidebar(&sidebar)
        .content(&content)
        .min_sidebar_width(320.0)
        .max_sidebar_width(420.0)
        .build();
    let toasts = adw::ToastOverlay::new();
    toasts.set_child(Some(&split));

    let ui = Rc::new(Ui {
        recordings: RefCell::new(vec![]),
        list: list.clone(),
        detail,
        content,
        split,
        toasts: toasts.clone(),
    });
    {
        let ui = ui.clone();
        list.connect_row_selected(move |_, row| {
            if let Some(row) = row {
                ui.show(row.index() as usize);
            }
        });
    }
    sidebar_view.add_bottom_bar(&record_bar(ui.clone()));
    ui.reload(None);

    let window = adw::ApplicationWindow::builder()
        .application(app)
        .title("Grabador de reuniones")
        .default_width(1200)
        .default_height(820)
        .content(&toasts)
        .build();
    follow_dark_mode(&window);
    window.present();
}

// Bottom of the sidebar: sources + Grabar, or timer + pause/resume + stop while recording.
fn record_bar(ui: Rc<Ui>) -> gtk::Widget {
    let mic = gtk::ToggleButton::builder()
        .icon_name("audio-input-microphone-symbolic")
        .tooltip_text("Micrófono")
        .active(true)
        .build();
    let pc = gtk::ToggleButton::builder()
        .icon_name("audio-speakers-symbolic")
        .tooltip_text("Audio del PC (todo lo que suena)")
        .active(true)
        .build();
    let start = gtk::Button::builder()
        .label("Grabar")
        .css_classes(["suggested-action", "pill"])
        .hexpand(true)
        .build();
    let idle = gtk::Box::new(Orientation::Horizontal, 6);
    idle.append(&mic);
    idle.append(&pc);
    idle.append(&start);

    let timer = gtk::Label::builder().label("00:00").hexpand(true).xalign(0.0).build();
    timer.add_css_class("recording-timer");
    let pause = gtk::Button::builder()
        .icon_name("media-playback-pause-symbolic")
        .tooltip_text("Pausar")
        .build();
    let stop = gtk::Button::builder()
        .label("Detener")
        .css_classes(["destructive-action", "pill"])
        .build();
    let active = gtk::Box::new(Orientation::Horizontal, 6);
    active.append(&timer);
    active.append(&pause);
    active.append(&stop);

    let stack = gtk::Stack::new();
    stack.add_named(&idle, Some("idle"));
    stack.add_named(&active, Some("active"));
    let bar = gtk::Box::builder()
        .margin_top(8)
        .margin_bottom(8)
        .margin_start(10)
        .margin_end(10)
        .build();
    stack.set_hexpand(true);
    bar.append(&stack);

    let recorder: Rc<RefCell<Option<Recorder>>> = Rc::new(RefCell::new(None));
    let seconds = Rc::new(Cell::new(0u32));
    let paused = Rc::new(Cell::new(false));

    // One tick per second while recording (not while paused).
    {
        let (recorder, seconds, paused, timer) =
            (recorder.clone(), seconds.clone(), paused.clone(), timer.clone());
        glib::timeout_add_seconds_local(1, move || {
            if recorder.borrow().is_some() && !paused.get() {
                seconds.set(seconds.get() + 1);
                timer.set_label(&format!("●  {}", clock(seconds.get() as f64)));
            }
            glib::ControlFlow::Continue
        });
    }

    {
        let (recorder, seconds, paused, stack, timer, pause, ui) = (
            recorder.clone(),
            seconds.clone(),
            paused.clone(),
            stack.clone(),
            timer.clone(),
            pause.clone(),
            ui.clone(),
        );
        start.connect_clicked(move |_| match Recorder::start(mic.is_active(), pc.is_active(), None) {
            Ok(r) => {
                *recorder.borrow_mut() = Some(r);
                seconds.set(0);
                paused.set(false);
                timer.set_label("●  00:00");
                pause.set_icon_name("media-playback-pause-symbolic");
                pause.set_tooltip_text(Some("Pausar"));
                stack.set_visible_child_name("active");
            }
            Err(e) => ui.toast(&e),
        });
    }

    {
        let (recorder, paused, ui) = (recorder.clone(), paused.clone(), ui.clone());
        pause.connect_clicked(move |button| {
            let mut guard = recorder.borrow_mut();
            let Some(r) = guard.as_mut() else { return };
            let result = if paused.get() { r.resume() } else { r.pause() };
            match result {
                Ok(()) => {
                    paused.set(!paused.get());
                    button.set_icon_name(if paused.get() {
                        "media-record-symbolic"
                    } else {
                        "media-playback-pause-symbolic"
                    });
                    button.set_tooltip_text(Some(if paused.get() { "Reanudar" } else { "Pausar" }));
                }
                Err(e) => ui.toast(&e),
            }
        });
    }

    stop.connect_clicked(move |button| {
        let Some(r) = recorder.borrow_mut().take() else { return };
        button.set_sensitive(false);
        let (stack, button, ui, seconds) = (stack.clone(), button.clone(), ui.clone(), seconds.get());
        let stereo = r.is_stereo();
        let id = db::new_id();
        let dest = db::data_dir().join("media").join(&id);
        glib::spawn_future_local(async move {
            let result = gtk::gio::spawn_blocking(move || r.finish(&dest)).await;
            let saved = match result {
                Ok(Ok(size)) => save_recording(&id, seconds, size, stereo).map_err(|e| e.to_string()),
                Ok(Err(e)) => Err(e),
                Err(_) => Err("La grabación falló al cerrarse.".to_string()),
            };
            match saved {
                Ok(()) => ui.reload(Some(&id)),
                Err(e) => ui.toast(&format!("No se pudo guardar la grabación: {e}")),
            }
            button.set_sensitive(true);
            stack.set_visible_child_name("idle");
        });
    });

    bar.upcast()
}

// Same metadata as recordings made in the browser.
fn save_recording(id: &str, seconds: u32, size: u64, stereo: bool) -> rusqlite::Result<()> {
    let now = chrono::Utc::now();
    let created_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let meta = serde_json::json!({
        "id": id,
        "name": format!("reunion-{}.webm", created_at.replace(':', "-")),
        "displayTitle": "",
        "createdAt": created_at,
        "mediaKind": "audio",
        "audioChannels": if stereo { "mic-left-pc-right" } else { "mono" },
        "durationSeconds": seconds,
        "sizeBytes": size,
        "mimeType": "audio/webm;codecs=opus",
    });
    db::insert(&db::open()?, id, &created_at, &meta)
}

fn placeholder() -> gtk::Widget {
    adw::StatusPage::builder()
        .icon_name("audio-input-microphone-symbolic")
        .title("Elige una reunión")
        .description("Su audio, acta y transcripción aparecerán aquí.")
        .build()
        .upcast()
}

fn label(text: &str, classes: &[&str]) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .wrap(true)
        .xalign(0.0)
        .selectable(true)
        .css_classes(classes.to_vec())
        .build()
}

fn heading(text: &str) -> gtk::Label {
    let l = label(text, &["heading"]);
    l.set_selectable(false);
    l.set_margin_top(12);
    l
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn bullets(container: &gtk::Box, title: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    container.append(&heading(title));
    for item in items {
        container.append(&label(&format!("•  {item}"), &[]));
    }
}

fn recording_detail(recording: &Recording) -> gtk::Widget {
    let page = gtk::Box::builder()
        .orientation(Orientation::Vertical)
        .spacing(6)
        .margin_top(24)
        .margin_bottom(24)
        .margin_start(18)
        .margin_end(18)
        .build();

    page.append(&label(&recording.title(), &["title-1"]));
    page.append(&label(
        &format!(
            "{} · {}",
            local_date(recording.created_at()),
            clock(recording.duration_seconds())
        ),
        &["dim-label"],
    ));

    let media = gtk::MediaFile::for_filename(recording.media_path());
    let controls = gtk::MediaControls::builder().media_stream(&media).margin_top(12).build();
    page.append(&controls);

    match recording.report() {
        Some(report) => report_view(&page, report),
        None => {
            let status = adw::StatusPage::builder()
                .icon_name("x-office-document-symbolic")
                .title("Sin acta")
                .description("Esta reunión todavía no está transcrita.")
                .build();
            page.append(&status);
        }
    }

    if let Some(turns) = recording.transcription.as_ref().and_then(|t| t["speaker_turns"].as_array()) {
        let names = speaker_names(recording.report());
        let text = turns
            .iter()
            .map(|turn| {
                let speaker = turn["speaker"].as_str().unwrap_or("");
                let who = names
                    .iter()
                    .find(|(s, _)| s == speaker)
                    .map(|(_, n)| n.as_str())
                    .unwrap_or(speaker);
                format!(
                    "[{}] {}: {}",
                    clock(turn["start"].as_f64().unwrap_or(0.0)),
                    who,
                    turn["text"].as_str().unwrap_or("").trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let expander = gtk::Expander::builder()
            .label(format!("Transcripción ({} intervenciones)", turns.len()))
            .margin_top(18)
            .child(&label(&text, &[]))
            .build();
        page.append(&expander);
    }

    page.upcast()
}

fn speaker_names(report: Option<&Value>) -> Vec<(String, String)> {
    report
        .and_then(|r| r["participants"].as_array())
        .map(|ps| {
            ps.iter()
                .filter_map(|p| {
                    let name = p["name"].as_str().unwrap_or("").trim();
                    (!name.is_empty())
                        .then(|| (p["speaker"].as_str().unwrap_or("").to_string(), name.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn report_view(page: &gtk::Box, report: &Value) {
    page.append(&heading("Resumen"));
    page.append(&label(report["summary"].as_str().unwrap_or(""), &[]));

    if let Some(participants) = report["participants"].as_array().filter(|p| !p.is_empty()) {
        page.append(&heading("Participantes"));
        for p in participants {
            let speaker = p["speaker"].as_str().unwrap_or("");
            let name = p["name"].as_str().unwrap_or("").trim();
            let who = if name.is_empty() { speaker.to_string() } else { format!("{name} ({speaker})") };
            page.append(&label(&format!("•  {who}: {}", p["role"].as_str().unwrap_or("")), &[]));
        }
    }

    bullets(page, "Puntos clave", &strings(&report["key_points"]));

    if let Some(topics) = report["topics"].as_array().filter(|t| !t.is_empty()) {
        page.append(&heading("Temas tratados"));
        for t in topics {
            let hint = t["start_time_hint"].as_str().unwrap_or("");
            let title = t["title"].as_str().unwrap_or("");
            let topic = gtk::Box::new(Orientation::Vertical, 2);
            topic.append(&label(
                &if hint.is_empty() { title.to_string() } else { format!("{title}  ·  {hint}") },
                &["caption-heading"],
            ));
            topic.append(&label(t["summary"].as_str().unwrap_or(""), &[]));
            topic.set_margin_top(4);
            page.append(&topic);
        }
    }

    bullets(page, "Decisiones", &strings(&report["decisions"]));

    if let Some(items) = report["action_items"].as_array().filter(|a| !a.is_empty()) {
        page.append(&heading("Tareas"));
        for a in items {
            let mut line = format!("•  {}", a["task"].as_str().unwrap_or(""));
            let owner = a["owner"].as_str().unwrap_or("");
            let due = a["due_date"].as_str().unwrap_or("");
            if !owner.is_empty() {
                line += &format!(" — {owner}");
            }
            if !due.is_empty() {
                line += &format!(" ({due})");
            }
            page.append(&label(&line, &[]));
        }
    }

    bullets(page, "Riesgos", &strings(&report["risks"]));
    bullets(page, "Preguntas abiertas", &strings(&report["open_questions"]));
}
