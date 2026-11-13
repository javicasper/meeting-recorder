# Grabador de reuniones — apps nativas

Proyecto independiente de la versión web/docker de la raíz. Misma base de datos y mismo
formato (SQLite + un fichero de audio por reunión), mismos prompts y mismas llamadas a
Soniox y OpenAI.

- `linux/`: GTK4 + libadwaita, en Rust.
- `macos/`: SwiftUI (pendiente).

## Linux

- Graba con ffmpeg desde PipeWire/PulseAudio: micro por defecto (canal izquierdo) + todo lo
  que suena por la salida por defecto (canal derecho). Sin selectores.
- Transcripción con Soniox `stt-async-v6` (archivo) o `stt-rt-v6` (en directo mientras
  grabas), acta y preguntas con OpenAI.
- Datos: `~/.local/share/com.traventia.meeting-recorder/` (`meetings.db` + `media/`).
- Claves (Soniox, OpenAI): Ajustes (rueda), guardadas en
  `~/.config/com.traventia.meeting-recorder/settings.json` (solo lectura para el usuario).

### Paquetes

```bash
cd linux/packaging/arch && makepkg -si        # Arch
cd linux && cargo deb                          # Debian/Ubuntu → target/debian/*.deb
```

Dependencias en el equipo: gtk4 (≥ 4.12), libadwaita (≥ 1.5), ffmpeg, GStreamer base + good.

### Desarrollo

```bash
cd linux && cargo run
cargo test                                   # unit tests
cargo test -- --ignored                      # graba de verdad (necesita PipeWire)
MR_TEST_AUDIO=<webm> cargo test -- --ignored api_   # llamadas reales a Soniox/OpenAI (< 1 céntimo)
```

`assets/report_prompt.txt`, `ask_prompt.txt`, `report_schema.json` y `vocabulary.txt` son
copia de `server/` de la web: si cambian allí, copiarlos aquí.
