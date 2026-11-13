// Native Linux app (GTK4 + libadwaita) for the meeting recorder.
mod ai;
mod db;
mod detail;
mod export;
mod recorder;

use adw::prelude::*;
use chrono::{DateTime, Datelike, Local};
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

pub(crate) fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

pub(crate) fn local_date(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|d| d.with_timezone(&Local).format("%d/%m/%y %H:%M").to_string())
        .unwrap_or_default()
}

// Window state shared by the callbacks (GTK main thread only).
pub(crate) struct Ui {
    pub(crate) recordings: RefCell<Vec<Recording>>,
    pub(crate) selected: RefCell<Option<String>>,
    // Recording id -> what is running on it ("Transcribiendo…", "Generando acta…").
    pub(crate) busy: RefCell<HashMap<String, String>>,
    // Floating Q&A panel open (kept across refreshes).
    pub(crate) chat_open: Cell<bool>,
    list: gtk::ListBox,
    body: adw::Bin,
    content: adw::NavigationPage,
    content_header: adw::HeaderBar,
    header_actions: RefCell<Vec<gtk::Widget>>,
    split: adw::NavigationSplitView,
    toasts: adw::ToastOverlay,
    pub(crate) window: RefCell<Option<adw::ApplicationWindow>>,
}

impl Ui {
    pub(crate) fn toast(&self, message: &str) {
        self.toasts.add_toast(adw::Toast::builder().title(message).timeout(8).build());
    }

    // Re-reads the database and rebuilds the list, keeping the selection (or `select_id`).
    pub(crate) fn reload(self: &Rc<Self>, select_id: Option<&str>) {
        let recordings = db::open().and_then(|conn| db::load_all(&conn)).unwrap_or_else(|e| {
            self.toast(&format!("No se pudo leer la base de datos: {e}"));
            vec![]
        });
        let target = select_id.map(str::to_string).or_else(|| self.selected.borrow().clone());
        self.list.remove_all();
        for recording in &recordings {
            let row = adw::ActionRow::builder()
                .title(glib::markup_escape_text(&recording.title()))
                .subtitle(format!("{} · {}", short_date(recording.created_at()), clock(recording.duration_seconds())))
                .title_lines(2)
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
        // Group headers and search filter read `recordings`: recompute now that it is set.
        self.list.invalidate_headers();
        self.list.invalidate_filter();
        match index.and_then(|i| self.list.row_at_index(i as i32)) {
            Some(row) => {
                self.list.select_row(Some(&row));
                self.show(row.index() as usize);
            }
            None => {
                *self.selected.borrow_mut() = None;
                self.content.set_title("Reunión");
                self.set_header(None, vec![]);
                self.body.set_child(Some(&placeholder()));
            }
        }
    }

    fn show(self: &Rc<Self>, index: usize) {
        let recordings = self.recordings.borrow();
        let Some(recording) = recordings.get(index) else { return };
        *self.selected.borrow_mut() = Some(recording.id.clone());
        self.content.set_title(&recording.title());
        self.body.set_child(Some(&detail::show(self, recording)));
    }

    // Content header: optional title widget (tab switcher) + this meeting's actions.
    pub(crate) fn set_header(&self, title: Option<gtk::Widget>, actions: Vec<gtk::Widget>) {
        for old in self.header_actions.borrow_mut().drain(..) {
            self.content_header.remove(&old);
        }
        self.content_header.set_title_widget(title.as_ref());
        for widget in &actions {
            self.content_header.pack_end(widget);
        }
        *self.header_actions.borrow_mut() = actions;
    }

    pub(crate) fn recording(&self, id: &str) -> Option<(Value, Value, PathBuf)> {
        self.recordings
            .borrow()
            .iter()
            .find(|r| r.id == id)
            .map(|r| (r.transcription.clone().unwrap_or(Value::Null), r.chat.clone(), r.media_path()))
    }

    pub(crate) fn set_busy(self: &Rc<Self>, id: &str, message: Option<&str>) {
        match message {
            Some(m) => self.busy.borrow_mut().insert(id.to_string(), m.to_string()),
            None => self.busy.borrow_mut().remove(id),
        };
        self.reload(None);
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Step {
    Transcribe,
    Report,
}

// Transcribe (file) and/or generate the report, saving each result as it arrives.
pub(crate) fn process(ui: Rc<Ui>, id: String, step: Step) {
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

pub(crate) fn finish(ui: &Rc<Ui>, id: &str, error: Option<String>) {
    if let Some(e) = error {
        ui.toast(&e);
    }
    ui.set_busy(id, None);
}

const MONTHS: [&str; 12] = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

fn local(iso: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(iso).ok().map(|d| d.with_timezone(&Local))
}

// "27 oct · 13:31" for the list (the group header already says the month).
fn short_date(iso: &str) -> String {
    local(iso)
        .map(|d| format!("{} {} · {}", d.day(), &MONTHS[d.month0() as usize][..3], d.format("%H:%M")))
        .unwrap_or_default()
}

// Sidebar groups: Hoy, Ayer, Esta semana, then "Octubre 2026"…
fn date_group(iso: &str) -> String {
    let Some(d) = local(iso) else { return String::new() };
    let today = Local::now().date_naive();
    let days = (today - d.date_naive()).num_days();
    match days {
        0 => "Hoy".into(),
        1 => "Ayer".into(),
        2..=6 => "Esta semana".into(),
        _ => {
            let month = MONTHS[d.month0() as usize];
            let mut cap = month.chars();
            let month = cap.next().map(|c| c.to_uppercase().collect::<String>() + cap.as_str()).unwrap_or_default();
            format!("{month} {}", d.year())
        }
    }
}

// Lowercase, no accents/punctuation, for search. Empty stays empty (slug() would say "reunion").
fn fold(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    export::slug(text).replace('-', " ")
}

fn build_window(app: &adw::Application) {
    let list = gtk::ListBox::builder().css_classes(["navigation-sidebar"]).build();

    let content_header = adw::HeaderBar::new();
    let body = adw::Bin::builder().vexpand(true).child(&placeholder()).build();
    let content_view = adw::ToolbarView::new();
    content_view.add_top_bar(&content_header);
    content_view.set_content(Some(&body));
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
    let search = gtk::SearchEntry::builder()
        .placeholder_text("Buscar reuniones")
        .margin_start(10)
        .margin_end(10)
        .margin_bottom(6)
        .build();
    sidebar_view.add_top_bar(&search);
    sidebar_view.set_content(Some(
        &gtk::ScrolledWindow::builder().child(&list).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build(),
    ));
    let sidebar = adw::NavigationPage::new(&sidebar_view, "Reuniones");

    let split = adw::NavigationSplitView::builder()
        .sidebar(&sidebar)
        .content(&content)
        .min_sidebar_width(320.0)
        .max_sidebar_width(400.0)
        .build();
    let toasts = adw::ToastOverlay::new();
    toasts.set_child(Some(&split));

    let ui = Rc::new(Ui {
        recordings: RefCell::new(vec![]),
        selected: RefCell::new(None),
        busy: RefCell::new(HashMap::new()),
        chat_open: Cell::new(false),
        list: list.clone(),
        body,
        content,
        content_header,
        header_actions: RefCell::new(vec![]),
        split,
        toasts: toasts.clone(),
        window: RefCell::new(None),
    });

    // Search by title (accent- and case-insensitive).
    {
        let (ui, search) = (ui.clone(), search.clone());
        list.set_filter_func(move |row| {
            let query = fold(&search.text());
            if query.is_empty() {
                return true;
            }
            ui.recordings
                .try_borrow()
                .ok()
                .and_then(|r| r.get(row.index() as usize).map(|r| fold(&r.title()).contains(&query)))
                .unwrap_or(true)
        });
    }
    {
        let list = list.clone();
        search.connect_search_changed(move |_| {
            list.invalidate_filter();
            list.invalidate_headers();
        });
    }
    // Date group headers.
    {
        let ui = ui.clone();
        list.set_header_func(move |row, before| {
            let Ok(recordings) = ui.recordings.try_borrow() else { return };
            let group = |r: &gtk::ListBoxRow| recordings.get(r.index() as usize).map(|r| date_group(r.created_at()));
            let current = group(row);
            if before.and_then(group) == current {
                row.set_header(None::<&gtk::Widget>);
            } else if let Some(text) = current {
                row.set_header(Some(&gtk::Label::builder().label(text).xalign(0.0).css_classes(["sidebar-group"]).build()));
            }
        });
    }
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
        .default_width(1240)
        .default_height(840)
        .content(&toasts)
        .build();
    window.set_icon_name(Some(APP_ID));
    *ui.window.borrow_mut() = Some(window.clone());
    {
        let ui = ui.clone();
        settings_button.connect_clicked(move |_| settings_dialog(&ui, false));
    }
    // Ctrl+F focuses the search.
    {
        let search = search.clone();
        let keys = gtk::EventControllerKey::new();
        keys.connect_key_pressed(move |_, key, _, state| {
            if state.contains(gtk::gdk::ModifierType::CONTROL_MASK) && key == gtk::gdk::Key::f {
                search.grab_focus();
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        window.add_controller(keys);
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

// Bottom of the sidebar: sources + Grabar, or timer + pause/resume + stop while recording.
// On stop the file is transcribed (Soniox async: cheaper and steadier than live) and summarized.
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
        .css_classes(["suggested-action", "pill", "record-button"])
        .hexpand(true)
        .tooltip_text("Empezar a grabar")
        .build();
    let start_content = gtk::Box::builder().spacing(8).halign(gtk::Align::Center).build();
    start_content.append(&gtk::Image::from_icon_name("media-record-symbolic"));
    start_content.append(&gtk::Label::new(Some("Grabar")));
    start.set_child(Some(&start_content));
    let sources = gtk::Box::builder().css_classes(["linked"]).build();
    sources.append(&mic);
    sources.append(&pc);
    let idle = gtk::Box::new(Orientation::Horizontal, 10);
    idle.append(&sources);
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
        start.connect_clicked(move |_| match Recorder::start(mic.is_active(), pc.is_active()) {
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
            button.set_sensitive(true);
            stack.set_visible_child_name("idle");
            match saved {
                Ok(()) if ai::has_keys() => {
                    ui.reload(Some(&id));
                    process(ui, id, Step::Transcribe);
                }
                Ok(()) => {
                    ui.reload(Some(&id));
                    ui.toast("Grabación guardada. Pon tus claves en Ajustes para transcribirla.");
                }
                Err(e) => {
                    ui.toast(&format!("No se pudo guardar la grabación: {e}"));
                    ui.reload(None);
                }
            }
        });
    });

    bar.upcast()
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

pub(crate) fn label(text: &str, classes: &[&str]) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .wrap(true)
        .xalign(0.0)
        .selectable(true)
        .css_classes(classes.to_vec())
        .build()
}

pub(crate) fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub(crate) fn speaker_names(report: Option<&Value>) -> Vec<(String, String)> {
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
