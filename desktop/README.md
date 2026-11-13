# Grabador de reuniones — app de escritorio

Proyecto independiente de la versión web/docker de la raíz: lleva su propia copia de la
interfaz (`src/`) y del backend (`server/`), empaquetados con Tauri (`src-tauri/`).

- Graba de forma nativa con ffmpeg desde PulseAudio/PipeWire: micro por defecto (canal
  izquierdo) + todo lo que suena por la salida por defecto (canal derecho). Sin selectores.
- Al abrirse arranca su backend (Node empaquetado) en `localhost:8790` y lo para al cerrarse.
- Datos: `~/.local/share/com.traventia.meeting-recorder/` (`meetings.db` + `media/`).
- Claves (Soniox, OpenAI): pantalla de ajustes, guardadas en
  `~/.config/com.traventia.meeting-recorder/settings.json`.
- Requisitos en el equipo: `ffmpeg`; para reproducir en la app, GStreamer
  (`gst-plugins-base`, `gst-plugins-good`).

## Instaladores

```bash
npm install
npm run bundle   # prepara backend + Node oficial y genera AppImage y .deb
```

Salen en `src-tauri/target/release/bundle/{appimage,deb}/`.

## Desarrollo

`npm run build && cargo run --manifest-path src-tauri/Cargo.toml` (usa `server/` y `dist/`
de esta carpeta y el `node` del sistema si no se ha ejecutado `prepare-bundle`).
