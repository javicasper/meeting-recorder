// Native Linux app (GTK4 + libadwaita) for the meeting recorder.
mod db;

use adw::prelude::*;
use chrono::{DateTime, Local};
use db::Recording;
use gtk::{glib, Orientation};
use serde_json::Value;
use std::rc::Rc;

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

fn build_window(app: &adw::Application) {
    let recordings: Rc<Vec<Recording>> = Rc::new(
        db::open().and_then(|conn| db::load_all(&conn)).unwrap_or_else(|e| {
            eprintln!("No se pudo leer la base de datos: {e}");
            vec![]
        }),
    );

    // Sidebar: list of recordings.
    let list = gtk::ListBox::builder().css_classes(["navigation-sidebar"]).build();
    for recording in recordings.iter() {
        let row = adw::ActionRow::builder()
            .title(glib::markup_escape_text(&recording.title()))
            .subtitle(format!(
                "{} · {}",
                local_date(recording.created_at()),
                clock(recording.duration_seconds())
            ))
            .build();
        if recording.report().is_some() {
            row.add_suffix(&gtk::Image::from_icon_name("document-text-symbolic"));
        }
        list.append(&row);
    }
    let sidebar_view = adw::ToolbarView::new();
    let sidebar_header = adw::HeaderBar::new();
    sidebar_header.set_title_widget(Some(&brand()));
    sidebar_view.add_top_bar(&sidebar_header);
    sidebar_view.set_content(Some(&gtk::ScrolledWindow::builder().child(&list).build()));
    let sidebar = adw::NavigationPage::new(&sidebar_view, "Reuniones");

    // Content: details of the selected recording.
    let detail = adw::Clamp::builder().maximum_size(860).build();
    detail.set_child(Some(&placeholder()));
    let content_view = adw::ToolbarView::new();
    content_view.add_top_bar(&adw::HeaderBar::new());
    content_view.set_content(Some(
        &gtk::ScrolledWindow::builder().child(&detail).vexpand(true).build(),
    ));
    let content = adw::NavigationPage::new(&content_view, "Reunión");

    let split = adw::NavigationSplitView::builder()
        .sidebar(&sidebar)
        .content(&content)
        .min_sidebar_width(320.0)
        .max_sidebar_width(420.0)
        .build();

    {
        let recordings = recordings.clone();
        let split = split.clone();
        list.connect_row_selected(move |_, row| {
            let Some(recording) = row.and_then(|r| recordings.get(r.index() as usize)) else {
                return;
            };
            content.set_title(&recording.title());
            detail.set_child(Some(&recording_detail(recording)));
            split.set_show_content(true);
        });
    }

    let window = adw::ApplicationWindow::builder()
        .application(app)
        .title("Grabador de reuniones")
        .default_width(1200)
        .default_height(820)
        .content(&split)
        .build();
    follow_dark_mode(&window);
    window.present();
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
                .icon_name("document-text-symbolic")
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
