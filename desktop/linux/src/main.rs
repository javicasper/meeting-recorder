// Native Linux app (GTK4 + libadwaita) for the meeting recorder.
mod ai;
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
    collections::HashMap,
    path::PathBuf,
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
    selected: RefCell<Option<String>>,
    // Recording id -> what is running on it ("Transcribiendo…", "Generando acta…").
    busy: RefCell<HashMap<String, String>>,
    // While recording with live transcription on: the label it writes into.
    live_label: RefCell<Option<gtk::Label>>,
    list: gtk::ListBox,
    detail: adw::Clamp,
    content: adw::NavigationPage,
    split: adw::NavigationSplitView,
    toasts: adw::ToastOverlay,
    window: RefCell<Option<adw::ApplicationWindow>>,
}

impl Ui {
    fn toast(&self, message: &str) {
        self.toasts.add_toast(adw::Toast::builder().title(message).timeout(8).build());
    }

    // Re-reads the database and rebuilds the list, keeping the selection (or `select_id`).
    fn reload(self: &Rc<Self>, select_id: Option<&str>) {
        let recordings = db::open().and_then(|conn| db::load_all(&conn)).unwrap_or_else(|e| {
            self.toast(&format!("No se pudo leer la base de datos: {e}"));
            vec![]
        });
        let target = select_id.map(str::to_string).or_else(|| self.selected.borrow().clone());
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
            if self.busy.borrow().contains_key(&recording.id) {
                row.add_suffix(&gtk::Spinner::builder().spinning(true).build());
            } else if recording.report().is_some() {
                row.add_suffix(&gtk::Image::from_icon_name("x-office-document-symbolic"));
            }
            self.list.append(&row);
        }
        let index = target.as_deref().and_then(|id| recordings.iter().position(|r| r.id == id));
        *self.recordings.borrow_mut() = recordings;
        match index.and_then(|i| self.list.row_at_index(i as i32)) {
            Some(row) => {
                self.list.select_row(Some(&row));
                self.show(row.index() as usize);
            }
            None if self.live_label.borrow().is_none() => {
                *self.selected.borrow_mut() = None;
                self.content.set_title("Reunión");
                self.detail.set_child(Some(&placeholder()));
            }
            None => {}
        }
    }

    fn show(self: &Rc<Self>, index: usize) {
        if self.live_label.borrow().is_some() {
            return; // the live transcript owns the content pane while recording
        }
        let recordings = self.recordings.borrow();
        let Some(recording) = recordings.get(index) else { return };
        *self.selected.borrow_mut() = Some(recording.id.clone());
        self.content.set_title(&recording.title());
        self.detail.set_child(Some(&recording_detail(self, recording)));
    }

    fn recording(&self, id: &str) -> Option<(Value, Value, PathBuf)> {
        self.recordings
            .borrow()
            .iter()
            .find(|r| r.id == id)
            .map(|r| (r.transcription.clone().unwrap_or(Value::Null), r.chat.clone(), r.media_path()))
    }

    fn set_busy(self: &Rc<Self>, id: &str, message: Option<&str>) {
        match message {
            Some(m) => self.busy.borrow_mut().insert(id.to_string(), m.to_string()),
            None => self.busy.borrow_mut().remove(id),
        };
        self.reload(None);
    }
}

#[derive(Clone, Copy)]
enum Step {
    Transcribe,
    Report,
}

// Transcribe (file) and/or generate the report, saving each result as it arrives.
fn process(ui: Rc<Ui>, id: String, step: Step) {
    glib::spawn_future_local(async move {
        let Some((mut transcription, _, media)) = ui.recording(&id) else { return };
        if let Step::Transcribe = step {
            ui.set_busy(&id, Some("Transcribiendo con Soniox… (unos minutos en reuniones largas)"));
            let rid = id.clone();
            match gtk::gio::spawn_blocking(move || ai::transcribe_file(&media, &rid)).await {
                Ok(Ok(t)) => {
                    if let Err(e) = db::set_transcription(&id, &t) {
                        ui.toast(&format!("No se pudo guardar la transcripción: {e}"));
                    }
                    transcription = t;
                }
                Ok(Err(e)) => return finish(&ui, &id, Some(e)),
                Err(_) => return finish(&ui, &id, Some("La transcripción falló.".into())),
            }
        }
        ui.set_busy(&id, Some("Generando acta…"));
        match gtk::gio::spawn_blocking(move || ai::add_report(transcription)).await {
            Ok(Ok(t)) => {
                let title: String = t["report"]["meeting_title"].as_str().unwrap_or("").trim().chars().take(80).collect();
                let saved = db::set_transcription(&id, &t)
                    .and_then(|_| if title.is_empty() { Ok(()) } else { db::set_title(&id, &title) });
                finish(&ui, &id, saved.err().map(|e| format!("No se pudo guardar el acta: {e}")));
            }
            Ok(Err(e)) => finish(&ui, &id, Some(e)),
            Err(_) => finish(&ui, &id, Some("La generación del acta falló.".into())),
        }
    });
}

fn finish(ui: &Rc<Ui>, id: &str, error: Option<String>) {
    if let Some(e) = error {
        ui.toast(&e);
    }
    ui.set_busy(id, None);
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
    let settings_button = gtk::Button::builder()
        .icon_name("emblem-system-symbolic")
        .tooltip_text("Ajustes")
        .build();
    sidebar_header.pack_end(&settings_button);
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
        selected: RefCell::new(None),
        busy: RefCell::new(HashMap::new()),
        live_label: RefCell::new(None),
        list: list.clone(),
        detail,
        content,
        split,
        toasts: toasts.clone(),
        window: RefCell::new(None),
    });
    {
        let ui = ui.clone();
        list.connect_row_activated(move |_, row| {
            ui.show(row.index() as usize);
            ui.split.set_show_content(true);
        });
    }
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
    window.set_icon_name(Some(APP_ID));
    *ui.window.borrow_mut() = Some(window.clone());
    {
        let ui = ui.clone();
        settings_button.connect_clicked(move |_| settings_dialog(&ui, false));
    }
    follow_dark_mode(&window);
    window.present();
    if !ai::has_keys() {
        settings_dialog(&ui, true);
    }
}

// Per-user API keys, stored in the app's config dir (owner-only).
fn settings_dialog(ui: &Rc<Ui>, first_run: bool) {
    let settings = ai::read_settings();
    let page = adw::PreferencesPage::new();
    let group = adw::PreferencesGroup::builder()
        .title("Claves")
        .description(if first_run {
            "Pon tus claves para poder transcribir y generar actas."
        } else {
            "Se guardan solo en este equipo."
        })
        .build();
    let entry = |title: &str, key: &str| {
        let row = adw::PasswordEntryRow::builder().title(title).build();
        row.set_text(settings.get(key).map(String::as_str).unwrap_or(""));
        group.add(&row);
        row
    };
    let soniox = entry("Clave de Soniox (transcripción)", "SONIOX_API_KEY");
    let openai = entry("Clave de OpenAI (actas y preguntas)", "OPENAI_API_KEY");
    let save = gtk::Button::builder()
        .label("Guardar")
        .css_classes(["suggested-action", "pill"])
        .halign(gtk::Align::Center)
        .margin_top(18)
        .build();
    group.add(&save);
    page.add(&group);
    let dialog = adw::PreferencesDialog::builder().title("Ajustes").build();
    dialog.add(&page);
    {
        let (ui, dialog) = (ui.clone(), dialog.clone());
        save.connect_clicked(move |_| {
            let mut next = ai::read_settings();
            next.insert("SONIOX_API_KEY".into(), soniox.text().trim().to_string());
            next.insert("OPENAI_API_KEY".into(), openai.text().trim().to_string());
            match ai::write_settings(&next) {
                Ok(()) => {
                    dialog.close();
                    ui.toast("Ajustes guardados.");
                }
                Err(e) => ui.toast(&format!("No se pudieron guardar los ajustes: {e}")),
            }
        });
    }
    dialog.present(ui.window.borrow().as_ref());
}

// Live transcript in the content pane while recording.
fn show_live(ui: &Rc<Ui>) {
    let text = label("Escuchando…", &["dim-label"]);
    let page = gtk::Box::builder()
        .orientation(Orientation::Vertical)
        .spacing(12)
        .margin_top(24)
        .margin_bottom(24)
        .margin_start(18)
        .margin_end(18)
        .build();
    page.append(&label("Transcripción en directo", &["title-2"]));
    page.append(&text);
    ui.content.set_title("Grabando");
    ui.detail.set_child(Some(&page));
    *ui.live_label.borrow_mut() = Some(text);
}

fn live_text(final_tokens: &[Value], partial: &str) -> String {
    let mut text = ai::turns_to_text(&ai::tokens_to_turns(final_tokens));
    if !partial.trim().is_empty() {
        text.push_str(&format!("\n{}…", partial.trim()));
    }
    text
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
    let live = gtk::ToggleButton::builder()
        .icon_name("format-justify-left-symbolic")
        .tooltip_text("Transcripción en directo (y acta al terminar)")
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
    idle.append(&live);
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
    stack.set_hexpand(true);
    let bar = gtk::Box::builder()
        .margin_top(8)
        .margin_bottom(8)
        .margin_start(10)
        .margin_end(10)
        .build();
    bar.append(&stack);

    let recorder: Rc<RefCell<Option<Recorder>>> = Rc::new(RefCell::new(None));
    // Live transcription results, if it was on for this recording.
    let live_events: Rc<RefCell<Option<async_channel::Receiver<ai::LiveEvent>>>> = Rc::new(RefCell::new(None));
    let current_id: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
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
        let (recorder, live_events, current_id, seconds, paused, stack, timer, pause, ui) = (
            recorder.clone(),
            live_events.clone(),
            current_id.clone(),
            seconds.clone(),
            paused.clone(),
            stack.clone(),
            timer.clone(),
            pause.clone(),
            ui.clone(),
        );
        start.connect_clicked(move |_| {
            let id = db::new_id();
            let use_live = live.is_active() && ai::has_keys();
            if live.is_active() && !use_live {
                ui.toast("Sin claves en Ajustes: se graba sin transcripción en directo.");
            }
            let (audio_tx, audio_rx) = std::sync::mpsc::channel();
            match Recorder::start(mic.is_active(), pc.is_active(), use_live.then_some(audio_tx)) {
                Ok(r) => {
                    *recorder.borrow_mut() = Some(r);
                    *current_id.borrow_mut() = id.clone();
                    seconds.set(0);
                    paused.set(false);
                    timer.set_label("●  00:00");
                    pause.set_icon_name("media-playback-pause-symbolic");
                    pause.set_tooltip_text(Some("Pausar"));
                    stack.set_visible_child_name("active");
                    if use_live {
                        let (events_tx, events_rx) = async_channel::unbounded();
                        std::thread::spawn(move || ai::run_live(id, audio_rx, events_tx));
                        show_live(&ui);
                        // Updates go to the label; Done is left for the stop handler.
                        let (ui, events_rx2) = (ui.clone(), events_rx.clone());
                        *live_events.borrow_mut() = Some(events_rx);
                        glib::spawn_future_local(async move {
                            while let Ok(event) = events_rx2.recv().await {
                                match event {
                                    ai::LiveEvent::Update { final_tokens, partial } => {
                                        if let Some(l) = ui.live_label.borrow().as_ref() {
                                            l.set_label(&live_text(&final_tokens, &partial));
                                            l.remove_css_class("dim-label");
                                        }
                                    }
                                    done @ ai::LiveEvent::Done { .. } => {
                                        // Hand it back to the stop handler.
                                        let _ = events_rx2.close();
                                        LIVE_DONE.with(|d| *d.borrow_mut() = Some(done));
                                        break;
                                    }
                                }
                            }
                        });
                    }
                }
                Err(e) => ui.toast(&e),
            }
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
        let had_live = live_events.borrow_mut().take().is_some();
        let (stack, button, ui, seconds) = (stack.clone(), button.clone(), ui.clone(), seconds.get());
        let stereo = r.is_stereo();
        let id = current_id.borrow().clone();
        let dest = db::data_dir().join("media").join(&id);
        glib::spawn_future_local(async move {
            if let Some(l) = ui.live_label.borrow().as_ref() {
                l.set_label(&format!("{}\n\nCerrando la grabación…", l.label()));
            }
            let result = gtk::gio::spawn_blocking(move || r.finish(&dest)).await;
            let saved = match result {
                Ok(Ok(size)) => save_recording(&id, seconds, size, stereo).map_err(|e| e.to_string()),
                Ok(Err(e)) => Err(e),
                Err(_) => Err("La grabación falló al cerrarse.".to_string()),
            };
            button.set_sensitive(true);
            stack.set_visible_child_name("idle");
            if let Err(e) = saved {
                *ui.live_label.borrow_mut() = None;
                ui.toast(&format!("No se pudo guardar la grabación: {e}"));
                ui.reload(None);
                return;
            }
            if !had_live {
                ui.reload(Some(&id));
                return;
            }
            // Wait for Soniox to process the tail of the audio (ffmpeg's pipe is closed now).
            ui.busy.borrow_mut().insert(id.clone(), "Cerrando la transcripción en directo…".into());
            let done = loop {
                if let Some(done) = LIVE_DONE.with(|d| d.borrow_mut().take()) {
                    break done;
                }
                glib::timeout_future(std::time::Duration::from_millis(200)).await;
            };
            *ui.live_label.borrow_mut() = None;
            ui.busy.borrow_mut().remove(&id);
            let ai::LiveEvent::Done { tokens, complete, error } = done else { return };
            let turns = ai::tokens_to_turns(&tokens);
            if !complete || turns.is_empty() {
                ui.reload(Some(&id));
                ui.toast(&format!(
                    "{} Usa «Transcribir» para procesar el archivo entero.",
                    error.unwrap_or_else(|| "La transcripción en directo no se completó.".into())
                ));
                return;
            }
            let cost = ai::soniox_cost_usd(seconds as f64, tokens.len(), true);
            let transcription = ai::build_transcription(&id, turns, "soniox stt-rt-v6 (directo)", cost);
            if let Err(e) = db::set_transcription(&id, &transcription) {
                ui.toast(&format!("No se pudo guardar la transcripción: {e}"));
            }
            ui.reload(Some(&id));
            process(ui, id, Step::Report);
        });
    });

    bar.upcast()
}

thread_local! {
    // Final live result, passed from the live-events task to the stop handler.
    static LIVE_DONE: RefCell<Option<ai::LiveEvent>> = const { RefCell::new(None) };
}

// Same metadata as recordings made in the browser.
fn save_recording(id: &str, seconds: u32, size: u64, stereo: bool) -> rusqlite::Result<()> {
    let created_at = ai::now_iso();
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

fn recording_detail(ui: &Rc<Ui>, recording: &Recording) -> gtk::Widget {
    let page = gtk::Box::builder()
        .orientation(Orientation::Vertical)
        .spacing(6)
        .margin_top(24)
        .margin_bottom(24)
        .margin_start(18)
        .margin_end(18)
        .build();

    let title_row = gtk::Box::new(Orientation::Horizontal, 12);
    let title = label(&recording.title(), &["title-1"]);
    title.set_hexpand(true);
    title_row.append(&title);
    title_row.append(&recording_menu(ui, recording));
    page.append(&title_row);
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

    let busy = ui.busy.borrow().get(&recording.id).cloned();
    if let Some(message) = busy {
        let row = gtk::Box::builder().spacing(10).margin_top(18).margin_bottom(6).build();
        row.append(&gtk::Spinner::builder().spinning(true).build());
        row.append(&label(&message, &["dim-label"]));
        page.append(&row);
    } else if let Some((text, step)) = match (&recording.transcription, recording.report()) {
        (None, _) => Some(("Transcribir", Step::Transcribe)),
        (Some(_), None) => Some(("Generar acta", Step::Report)),
        _ => None,
    } {
        let button = gtk::Button::builder()
            .label(text)
            .css_classes(["suggested-action", "pill"])
            .halign(gtk::Align::Start)
            .margin_top(18)
            .build();
        let (ui, id) = (ui.clone(), recording.id.clone());
        button.connect_clicked(move |_| process(ui.clone(), id.clone(), step));
        page.append(&button);
    }

    if let Some(report) = recording.report() {
        report_view(&page, report);
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
        page.append(&chat_view(ui, recording));
    }

    page.upcast()
}

// "⋮" menu: rename, export, retranscribe, regenerate report, delete.
fn recording_menu(ui: &Rc<Ui>, recording: &Recording) -> gtk::Widget {
    let menu = gtk::gio::Menu::new();
    menu.append(Some("Renombrar…"), Some("rec.rename"));
    if recording.report().is_some() {
        menu.append(Some("Exportar acta (.md)…"), Some("rec.export"));
        menu.append(Some("Regenerar acta"), Some("rec.report"));
    }
    if recording.transcription.is_some() {
        menu.append(Some("Volver a transcribir"), Some("rec.transcribe"));
    }
    let danger = gtk::gio::Menu::new();
    danger.append(Some("Borrar reunión…"), Some("rec.delete"));
    menu.append_section(None, &danger);

    let button = gtk::MenuButton::builder()
        .icon_name("view-more-symbolic")
        .menu_model(&menu)
        .valign(gtk::Align::Start)
        .tooltip_text("Más acciones")
        .build();
    let busy = ui.busy.borrow().contains_key(&recording.id);
    button.set_sensitive(!busy);

    let group = gtk::gio::SimpleActionGroup::new();
    let add = |name: &str, f: Box<dyn Fn()>| {
        let action = gtk::gio::SimpleAction::new(name, None);
        action.connect_activate(move |_, _| f());
        group.add_action(&action);
    };
    let id = recording.id.clone();
    let title = recording.title();
    {
        let (ui, id, title) = (ui.clone(), id.clone(), title.clone());
        add("rename", Box::new(move || rename_dialog(&ui, &id, &title)));
    }
    {
        let (ui, id) = (ui.clone(), id.clone());
        add("export", Box::new(move || export_markdown(&ui, &id)));
    }
    {
        let (ui, id) = (ui.clone(), id.clone());
        add("report", Box::new(move || process(ui.clone(), id.clone(), Step::Report)));
    }
    {
        let (ui, id) = (ui.clone(), id.clone());
        add("transcribe", Box::new(move || process(ui.clone(), id.clone(), Step::Transcribe)));
    }
    {
        let (ui, id, title) = (ui.clone(), id.clone(), title.clone());
        add("delete", Box::new(move || delete_dialog(&ui, &id, &title)));
    }
    button.insert_action_group("rec", Some(&group));
    button.upcast()
}

fn rename_dialog(ui: &Rc<Ui>, id: &str, title: &str) {
    let entry = gtk::Entry::builder().text(title).activates_default(true).build();
    let dialog = adw::AlertDialog::builder()
        .heading("Renombrar reunión")
        .extra_child(&entry)
        .default_response("save")
        .close_response("cancel")
        .build();
    dialog.add_responses(&[("cancel", "Cancelar"), ("save", "Guardar")]);
    dialog.set_response_appearance("save", adw::ResponseAppearance::Suggested);
    let (ui2, id) = (ui.clone(), id.to_string());
    dialog.connect_response(Some("save"), move |_, _| {
        let title = entry.text().trim().to_string();
        if title.is_empty() {
            return;
        }
        match db::set_title(&id, &title) {
            Ok(()) => ui2.reload(None),
            Err(e) => ui2.toast(&format!("No se pudo renombrar: {e}")),
        }
    });
    dialog.present(ui.window.borrow().as_ref());
}

fn delete_dialog(ui: &Rc<Ui>, id: &str, title: &str) {
    let dialog = adw::AlertDialog::builder()
        .heading("¿Borrar la reunión?")
        .body(format!("Se borran «{title}», su audio, la transcripción y el acta. No se puede deshacer."))
        .default_response("cancel")
        .close_response("cancel")
        .build();
    dialog.add_responses(&[("cancel", "Cancelar"), ("delete", "Borrar")]);
    dialog.set_response_appearance("delete", adw::ResponseAppearance::Destructive);
    let (ui2, id) = (ui.clone(), id.to_string());
    dialog.connect_response(Some("delete"), move |_, _| match db::delete(&id) {
        Ok(()) => {
            *ui2.selected.borrow_mut() = None;
            ui2.reload(None);
        }
        Err(e) => ui2.toast(&format!("No se pudo borrar: {e}")),
    });
    dialog.present(ui.window.borrow().as_ref());
}

fn export_markdown(ui: &Rc<Ui>, id: &str) {
    let recordings = ui.recordings.borrow();
    let Some(recording) = recordings.iter().find(|r| r.id == id) else { return };
    let markdown = meeting_markdown(recording);
    let file_name = format!("{}-acta.md", slug(&recording.title()));
    let dialog = gtk::FileDialog::builder().title("Exportar acta").initial_name(file_name).build();
    let ui2 = ui.clone();
    dialog.save(ui.window.borrow().as_ref(), gtk::gio::Cancellable::NONE, move |result| {
        let Ok(file) = result else { return };
        let Some(path) = file.path() else { return };
        match std::fs::write(&path, &markdown) {
            Ok(()) => ui2.toast(&format!("Acta guardada en {}", path.display())),
            Err(e) => ui2.toast(&format!("No se pudo guardar: {e}")),
        }
    });
}

fn slug(text: &str) -> String {
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
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "reunion".into() } else { out.chars().take(80).collect() }
}

// Same layout as the web's buildMeetingMarkdown.
fn meeting_markdown(recording: &Recording) -> String {
    let report = recording.report().cloned().unwrap_or(Value::Null);
    let names = speaker_names(Some(&report));
    let mut summary = vec![];
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
            summary.push(format!("- {}", t["title"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or(format!("Tema {}", i + 1))));
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

    let transcript = recording
        .transcription
        .as_ref()
        .and_then(|t| t["speaker_turns"].as_array())
        .map(|turns| {
            turns
                .iter()
                .map(|turn| {
                    let speaker = turn["speaker"].as_str().unwrap_or("");
                    let who = names.iter().find(|(s, _)| s == speaker).map(|(_, n)| n.as_str()).unwrap_or(speaker);
                    format!("**[{}] {who}:** {}", clock(turn["start"].as_f64().unwrap_or(0.0)), turn["text"].as_str().unwrap_or(""))
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default();
    let date = DateTime::parse_from_rfc3339(recording.created_at())
        .map(|d| d.with_timezone(&Local).format("%d/%m/%y, %H:%M:%S").to_string())
        .unwrap_or_default();
    [
        format!("# {}", recording.title()),
        format!("{date} · {}", clock(recording.duration_seconds())),
        "## Resumen".into(),
        summary.join("\n").trim().to_string(),
        "## Transcripción".into(),
        transcript,
    ]
    .join("\n\n")
}

// Questions about the meeting, answered from its transcript and report.
fn chat_view(ui: &Rc<Ui>, recording: &Recording) -> gtk::Widget {
    let section = gtk::Box::builder().orientation(Orientation::Vertical).spacing(8).build();
    section.append(&heading("Preguntas sobre la reunión"));
    for message in recording.chat.as_array().into_iter().flatten() {
        let content = message["content"].as_str().unwrap_or("");
        let l = if message["role"] == "user" {
            label(&format!("Tú: {content}"), &["heading"])
        } else {
            label(content, &[])
        };
        section.append(&l);
    }
    let entry = gtk::Entry::builder()
        .placeholder_text("Pregunta algo sobre esta reunión…")
        .hexpand(true)
        .build();
    let send = gtk::Button::builder()
        .icon_name("mail-send-symbolic")
        .tooltip_text("Preguntar")
        .css_classes(["suggested-action"])
        .build();
    let row = gtk::Box::new(Orientation::Horizontal, 6);
    row.append(&entry);
    row.append(&send);
    let busy = ui.busy.borrow().contains_key(&recording.id);
    row.set_sensitive(!busy);
    section.append(&row);

    let ask = {
        let (ui, id, entry) = (ui.clone(), recording.id.clone(), entry.clone());
        move || {
            let question = entry.text().trim().to_string();
            if question.is_empty() {
                return;
            }
            let Some((transcription, chat, _)) = ui.recording(&id) else { return };
            let (ui, id) = (ui.clone(), id.clone());
            glib::spawn_future_local(async move {
                ui.set_busy(&id, Some("Pensando la respuesta…"));
                let result = gtk::gio::spawn_blocking(move || ai::ask(&transcription, &chat, &question)).await;
                let error = match result {
                    Ok(Ok(chat)) => db::set_chat(&id, &chat).err().map(|e| e.to_string()),
                    Ok(Err(e)) => Some(e),
                    Err(_) => Some("La pregunta falló.".into()),
                };
                finish(&ui, &id, error);
            });
        }
    };
    let ask2 = ask.clone();
    entry.connect_activate(move |_| ask2());
    send.connect_clicked(move |_| ask());
    section.set_margin_top(18);
    section.upcast()
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
