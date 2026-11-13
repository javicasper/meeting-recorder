// One meeting: header actions, "Acta" / "Transcripción" tabs, floating Q&A panel.
use crate::db::{self, Recording};
use crate::export;
use crate::{ai, clock, finish, label, local_date, process, speaker_names, strings, Step, Ui};
use adw::prelude::*;
use gtk::{glib, Align, Orientation};
use serde_json::Value;
use std::rc::Rc;

// Builds the page and puts this meeting's actions + tab switcher in the content header.
pub fn show(ui: &Rc<Ui>, recording: &Recording) -> gtk::Widget {
    let media = gtk::MediaFile::for_filename(recording.media_path());
    let busy = ui.busy.borrow().get(&recording.id).cloned();

    let stack = adw::ViewStack::new();
    stack.add_titled_with_icon(&scrolled(&acta_page(ui, recording, &media, busy.as_deref())), Some("acta"), "Acta", "x-office-document-symbolic");
    if let Some(turns) = recording.transcription.as_ref().and_then(|t| t["speaker_turns"].as_array()) {
        let page = stack.add_titled_with_icon(&scrolled(&transcript_page(recording, turns, &media)), Some("transcript"), "Transcripción", "text-x-generic-symbolic");
        page.set_badge_number(turns.len() as u32);
    }
    let switcher = adw::ViewSwitcher::builder().stack(&stack).policy(adw::ViewSwitcherPolicy::Wide).build();
    ui.set_header(Some(switcher.upcast()), header_actions(ui, recording, busy.is_some()));

    let overlay = gtk::Overlay::builder().child(&stack).build();
    if recording.transcription.is_some() {
        add_chat(ui, recording, &overlay, busy.is_some());
    }
    overlay.upcast()
}

fn scrolled(child: &impl IsA<gtk::Widget>) -> gtk::ScrolledWindow {
    let clamp = adw::Clamp::builder().maximum_size(860).child(child).build();
    gtk::ScrolledWindow::builder().child(&clamp).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build()
}

fn page_box() -> gtk::Box {
    gtk::Box::builder()
        .orientation(Orientation::Vertical)
        .spacing(14)
        .margin_top(24)
        .margin_bottom(96) // room for the floating "Preguntar" button
        .margin_start(18)
        .margin_end(18)
        .build()
}

fn chip(text: &str, icon: Option<&str>) -> gtk::Widget {
    let b = gtk::Box::builder().spacing(5).css_classes(["chip"]).build();
    if let Some(icon) = icon {
        b.append(&gtk::Image::from_icon_name(icon));
    }
    b.append(&gtk::Label::new(Some(text)));
    b.upcast()
}

// Clickable "mm:ss" that jumps the player there.
fn time_button(seconds: f64, media: &gtk::MediaFile) -> gtk::Button {
    let button = gtk::Button::builder()
        .label(clock(seconds))
        .css_classes(["time-pill", "flat"])
        .valign(Align::Start)
        .tooltip_text("Escuchar desde aquí")
        .build();
    let media = media.clone();
    button.connect_clicked(move |_| {
        media.seek((seconds * 1_000_000.0) as i64);
        media.play();
    });
    button
}

fn parse_clock(text: &str) -> Option<f64> {
    let parts: Vec<f64> = text.trim().split(':').map(|p| p.parse::<f64>().ok()).collect::<Option<_>>()?;
    Some(parts.iter().fold(0.0, |acc, p| acc * 60.0 + p))
}

// Card with an icon + title header; returns (card, body).
fn card(icon: &str, title: &str) -> (gtk::Box, gtk::Box) {
    let card = gtk::Box::builder().orientation(Orientation::Vertical).spacing(10).css_classes(["card", "section-card"]).build();
    let head = gtk::Box::builder().spacing(8).build();
    head.append(&gtk::Image::builder().icon_name(icon).css_classes(["section-icon"]).build());
    head.append(&gtk::Label::builder().label(title).css_classes(["heading"]).xalign(0.0).build());
    card.append(&head);
    let body = gtk::Box::builder().orientation(Orientation::Vertical).spacing(8).build();
    card.append(&body);
    (card, body)
}

fn bullet_card(page: &gtk::Box, icon: &str, title: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    let (card, body) = card(icon, title);
    for item in items {
        let row = gtk::Box::builder().spacing(10).build();
        row.append(&gtk::Label::builder().label("•").css_classes(["accent"]).valign(Align::Start).build());
        let l = label(item, &[]);
        l.set_hexpand(true);
        row.append(&l);
        body.append(&row);
    }
    page.append(&card);
}

fn acta_page(ui: &Rc<Ui>, recording: &Recording, media: &gtk::MediaFile, busy: Option<&str>) -> gtk::Box {
    let page = page_box();

    // Hero: title, chips, player, and the next step if there is one.
    let hero = gtk::Box::builder().orientation(Orientation::Vertical).spacing(12).css_classes(["card", "hero-card"]).build();
    hero.append(&label(&recording.title(), &["title-1"]));
    let chips = gtk::Box::builder().spacing(6).build();
    chips.append(&chip(&local_date(recording.created_at()), Some("x-office-calendar-symbolic")));
    chips.append(&chip(&clock(recording.duration_seconds()), Some("preferences-system-time-symbolic")));
    if let Some(n) = recording.report().and_then(|r| r["participants"].as_array()).map(Vec::len).filter(|n| *n > 0) {
        chips.append(&chip(&format!("{n} participantes"), Some("system-users-symbolic")));
    }
    hero.append(&chips);
    hero.append(&gtk::MediaControls::builder().media_stream(media).css_classes(["player"]).build());

    if let Some(message) = busy {
        let row = gtk::Box::builder().spacing(10).css_classes(["busy-row"]).build();
        row.append(&gtk::Spinner::builder().spinning(true).build());
        row.append(&label(message, &["dim-label"]));
        hero.append(&row);
    } else if let Some((text, step, hint)) = match (&recording.transcription, recording.report()) {
        (None, _) => Some(("Transcribir", Step::Transcribe, "Transcribe el audio con Soniox y después genera el acta.")),
        (Some(_), None) => Some(("Generar acta", Step::Report, "La transcripción está lista; falta el acta.")),
        _ => None,
    } {
        let row = gtk::Box::builder().spacing(12).build();
        let button = gtk::Button::builder().label(text).css_classes(["suggested-action", "pill"]).build();
        let (ui, id) = (ui.clone(), recording.id.clone());
        button.connect_clicked(move |_| process(ui.clone(), id.clone(), step));
        row.append(&button);
        row.append(&label(hint, &["dim-label"]));
        hero.append(&row);
    }
    page.append(&hero);

    let Some(report) = recording.report() else { return page };

    let (summary, body) = card("text-x-generic-symbolic", "Resumen");
    body.append(&label(report["summary"].as_str().unwrap_or(""), &["body-text"]));
    page.append(&summary);

    if let Some(participants) = report["participants"].as_array().filter(|p| !p.is_empty()) {
        let (card, body) = card("system-users-symbolic", "Participantes");
        for p in participants {
            let speaker = p["speaker"].as_str().unwrap_or("");
            let name = p["name"].as_str().unwrap_or("").trim();
            let row = gtk::Box::builder().spacing(12).build();
            row.append(&adw::Avatar::new(36, Some(if name.is_empty() { speaker } else { name }), !name.is_empty()));
            let text = gtk::Box::builder().orientation(Orientation::Vertical).spacing(2).valign(Align::Center).build();
            let who = if name.is_empty() { speaker.to_string() } else { format!("{name}  ·  {speaker}") };
            text.append(&label(&who, &["heading"]));
            text.append(&label(p["role"].as_str().unwrap_or(""), &["dim-label"]));
            text.set_hexpand(true);
            row.append(&text);
            body.append(&row);
        }
        page.append(&card);
    }

    bullet_card(&page, "view-list-bullet-symbolic", "Puntos clave", &strings(&report["key_points"]));

    if let Some(topics) = report["topics"].as_array().filter(|t| !t.is_empty()) {
        let (card, body) = card("x-office-presentation-symbolic", "Temas tratados");
        for t in topics {
            let row = gtk::Box::builder().spacing(10).build();
            match t["start_time_hint"].as_str().and_then(parse_clock) {
                Some(seconds) => row.append(&time_button(seconds, media)),
                None => row.append(&gtk::Box::builder().width_request(54).build()),
            }
            let text = gtk::Box::builder().orientation(Orientation::Vertical).spacing(2).hexpand(true).build();
            text.append(&label(t["title"].as_str().unwrap_or(""), &["heading"]));
            text.append(&label(t["summary"].as_str().unwrap_or(""), &[]));
            row.append(&text);
            body.append(&row);
        }
        page.append(&card);
    }

    bullet_card(&page, "object-select-symbolic", "Decisiones", &strings(&report["decisions"]));

    if let Some(items) = report["action_items"].as_array().filter(|a| !a.is_empty()) {
        let (card, body) = card("task-due-symbolic", "Tareas");
        for a in items {
            let row = gtk::Box::builder().spacing(10).build();
            row.append(&gtk::Image::builder().icon_name("checkbox-checked-symbolic").css_classes(["accent"]).valign(Align::Start).build());
            let text = gtk::Box::builder().orientation(Orientation::Vertical).spacing(6).hexpand(true).build();
            text.append(&label(a["task"].as_str().unwrap_or(""), &[]));
            let meta = gtk::Box::builder().spacing(6).build();
            if let Some(owner) = a["owner"].as_str().filter(|s| !s.is_empty()) {
                meta.append(&chip(owner, Some("avatar-default-symbolic")));
            }
            if let Some(due) = a["due_date"].as_str().filter(|s| !s.is_empty()) {
                meta.append(&chip(due, Some("alarm-symbolic")));
            }
            if meta.first_child().is_some() {
                text.append(&meta);
            }
            row.append(&text);
            body.append(&row);
        }
        page.append(&card);
    }

    bullet_card(&page, "dialog-warning-symbolic", "Riesgos", &strings(&report["risks"]));
    bullet_card(&page, "dialog-question-symbolic", "Preguntas abiertas", &strings(&report["open_questions"]));
    page
}

fn transcript_page(recording: &Recording, turns: &[Value], media: &gtk::MediaFile) -> gtk::Box {
    let page = page_box();
    page.set_spacing(4);
    let names = speaker_names(recording.report());
    let mut speakers: Vec<String> = vec![];
    for turn in turns {
        let speaker = turn["speaker"].as_str().unwrap_or("").to_string();
        if !speakers.contains(&speaker) {
            speakers.push(speaker.clone());
        }
        let color = speakers.iter().position(|s| *s == speaker).unwrap_or(0) % 6 + 1;
        let who = names.iter().find(|(s, _)| *s == speaker).map(|(_, n)| n.clone()).unwrap_or(speaker);

        let row = gtk::Box::builder().spacing(10).css_classes(["turn"]).build();
        row.append(&time_button(turn["start"].as_f64().unwrap_or(0.0), media));
        let text = gtk::Box::builder().orientation(Orientation::Vertical).spacing(2).hexpand(true).build();
        text.append(&gtk::Label::builder().label(&who).xalign(0.0).css_classes(["speaker", &format!("speaker-{color}")]).build());
        text.append(&label(turn["text"].as_str().unwrap_or("").trim(), &[]));
        row.append(&text);
        page.append(&row);
    }
    page
}

fn header_actions(ui: &Rc<Ui>, recording: &Recording, busy: bool) -> Vec<gtk::Widget> {
    let audio = gtk::Button::builder().icon_name("folder-download-symbolic").tooltip_text("Descargar audio").build();
    {
        let (ui, id) = (ui.clone(), recording.id.clone());
        audio.connect_clicked(move |_| download_audio(&ui, &id));
    }
    let package = gtk::Button::builder()
        .icon_name("package-x-generic-symbolic")
        .tooltip_text("Descargar paquete (.zip): audio + acta + transcripción")
        .build();
    {
        let (ui, id) = (ui.clone(), recording.id.clone());
        package.connect_clicked(move |_| download_zip(&ui, &id));
    }
    let menu = recording_menu(ui, recording);
    menu.set_sensitive(!busy);
    // pack_end order: rightmost first.
    vec![menu, package.upcast(), audio.upcast()]
}

// "⋮" menu: rename, export notes, regenerate report, retranscribe, delete.
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

    let button = gtk::MenuButton::builder().icon_name("view-more-symbolic").menu_model(&menu).tooltip_text("Más acciones").build();
    let group = gtk::gio::SimpleActionGroup::new();
    let add = |name: &str, f: Box<dyn Fn()>| {
        let action = gtk::gio::SimpleAction::new(name, None);
        action.connect_activate(move |_, _| f());
        group.add_action(&action);
    };
    let (id, title) = (recording.id.clone(), recording.title());
    {
        let (ui, id, title) = (ui.clone(), id.clone(), title.clone());
        add("rename", Box::new(move || rename_dialog(&ui, &id, &title)));
    }
    {
        let (ui, id) = (ui.clone(), id.clone());
        add("export", Box::new(move || export_notes(&ui, &id)));
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

// Save dialog, then `write(path)` off the UI thread.
fn save_as<F>(ui: &Rc<Ui>, title: &str, file_name: String, write: F)
where
    F: FnOnce(std::path::PathBuf) -> Result<(), String> + Send + 'static,
{
    let dialog = gtk::FileDialog::builder().title(title).initial_name(file_name).modal(true).build();
    let ui2 = ui.clone();
    dialog.save(ui.window.borrow().as_ref(), gtk::gio::Cancellable::NONE, move |result| {
        let Some(path) = result.ok().and_then(|f| f.path()) else { return };
        glib::spawn_future_local(async move {
            let shown = path.display().to_string();
            match gtk::gio::spawn_blocking(move || write(path)).await {
                Ok(Ok(())) => ui2.toast(&format!("Guardado en {shown}")),
                Ok(Err(e)) => ui2.toast(&format!("No se pudo guardar: {e}")),
                Err(_) => ui2.toast("No se pudo guardar."),
            }
        });
    });
}

fn download_audio(ui: &Rc<Ui>, id: &str) {
    let recordings = ui.recordings.borrow();
    let Some(r) = recordings.iter().find(|r| r.id == id) else { return };
    let source = r.media_path();
    save_as(ui, "Descargar audio", format!("{}.webm", export::base_name(r)), move |dest| {
        std::fs::copy(source, dest).map(|_| ()).map_err(|e| e.to_string())
    });
}

fn download_zip(ui: &Rc<Ui>, id: &str) {
    let recordings = ui.recordings.borrow();
    let Some(r) = recordings.iter().find(|r| r.id == id) else { return };
    let base = export::base_name(r);
    let audio = r.media_path();
    let notes = r.report().map(|_| export::meeting_markdown(r));
    let transcript = r.transcription.as_ref().map(|_| export::transcript_lines(r, false).join("\n\n"));
    save_as(ui, "Descargar paquete", format!("{base}.zip"), move |dest| {
        export::write_zip(&dest, &base, &audio, notes, transcript)
    });
}

fn export_notes(ui: &Rc<Ui>, id: &str) {
    let recordings = ui.recordings.borrow();
    let Some(r) = recordings.iter().find(|r| r.id == id) else { return };
    let markdown = export::meeting_markdown(r);
    save_as(ui, "Exportar acta", format!("{}-acta.md", export::base_name(r)), move |dest| {
        std::fs::write(dest, markdown).map_err(|e| e.to_string())
    });
}

// Floating "Preguntar" button + panel over the meeting (stays open across refreshes).
fn add_chat(ui: &Rc<Ui>, recording: &Recording, overlay: &gtk::Overlay, busy: bool) {
    let fab = gtk::Button::builder()
        .css_classes(["suggested-action", "pill", "fab"])
        .halign(Align::End)
        .valign(Align::End)
        .margin_end(24)
        .margin_bottom(24)
        .build();
    let fab_content = gtk::Box::builder().spacing(8).build();
    fab_content.append(&gtk::Image::from_icon_name("dialog-question-symbolic"));
    fab_content.append(&gtk::Label::new(Some("Preguntar")));
    fab.set_child(Some(&fab_content));

    let panel = gtk::Box::builder()
        .orientation(Orientation::Vertical)
        .css_classes(["chat-panel"])
        .halign(Align::End)
        .valign(Align::End)
        .margin_end(24)
        .margin_bottom(24)
        .width_request(400)
        .height_request(520)
        .build();
    let head = gtk::Box::builder().spacing(8).css_classes(["chat-head"]).build();
    head.append(&gtk::Image::from_icon_name("dialog-question-symbolic"));
    head.append(&gtk::Label::builder().label("Preguntas sobre la reunión").css_classes(["heading"]).hexpand(true).xalign(0.0).build());
    let close = gtk::Button::builder().icon_name("window-close-symbolic").css_classes(["flat", "circular"]).tooltip_text("Cerrar").build();
    head.append(&close);
    panel.append(&head);

    let messages = gtk::Box::builder().orientation(Orientation::Vertical).spacing(10).margin_top(12).margin_bottom(12).margin_start(12).margin_end(12).build();
    let history = recording.chat.as_array().cloned().unwrap_or_default();
    if history.is_empty() {
        messages.append(&label("Pregunta lo que quieras: qué se decidió, quién se encarga de algo, en qué minuto se habló de un tema…", &["dim-label"]));
    }
    for message in &history {
        let mine = message["role"] == "user";
        let bubble = label(message["content"].as_str().unwrap_or(""), &[if mine { "bubble-user" } else { "bubble-assistant" }]);
        bubble.set_halign(if mine { Align::End } else { Align::Start });
        bubble.set_xalign(0.0);
        bubble.set_max_width_chars(42);
        messages.append(&bubble);
    }
    if busy {
        let row = gtk::Box::builder().spacing(8).build();
        row.append(&gtk::Spinner::builder().spinning(true).build());
        row.append(&label("Pensando…", &["dim-label"]));
        messages.append(&row);
    }
    let scroll = gtk::ScrolledWindow::builder().child(&messages).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build();
    panel.append(&scroll);
    // Newest message in view.
    {
        let scroll = scroll.clone();
        glib::idle_add_local_once(move || {
            let adj = scroll.vadjustment();
            adj.set_value(adj.upper());
        });
    }

    let entry = gtk::Entry::builder().placeholder_text("Escribe una pregunta…").hexpand(true).sensitive(!busy).build();
    let send = gtk::Button::builder().icon_name("mail-send-symbolic").css_classes(["suggested-action", "circular"]).tooltip_text("Preguntar").sensitive(!busy).build();
    let input = gtk::Box::builder().spacing(6).css_classes(["chat-input"]).build();
    input.append(&entry);
    input.append(&send);
    panel.append(&input);

    overlay.add_overlay(&fab);
    overlay.add_overlay(&panel);
    let open = ui.chat_open.get();
    panel.set_visible(open);
    fab.set_visible(!open);
    if open && !busy {
        entry.grab_focus();
    }

    {
        let (ui, panel, fab2, entry) = (ui.clone(), panel.clone(), fab.clone(), entry.clone());
        fab.connect_clicked(move |_| {
            ui.chat_open.set(true);
            panel.set_visible(true);
            fab2.set_visible(false);
            entry.grab_focus();
        });
    }
    {
        let (ui, panel, fab) = (ui.clone(), panel.clone(), fab.clone());
        close.connect_clicked(move |_| {
            ui.chat_open.set(false);
            panel.set_visible(false);
            fab.set_visible(true);
        });
    }

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
}
