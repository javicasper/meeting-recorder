# Grabador de Reuniones

App web en React + Vite para grabar reuniones desde el navegador.

## Funcionalidades

- Graba pantalla y audio.
- Mezcla audio del sistema y microfono en una sola pista.
- Pausar y reanudar grabacion.
- Vista previa en tiempo real.
- Descarga del archivo al finalizar (`.webm`).
- Historial de grabaciones persistente en IndexedDB (sobrevive a recargas).

## Requisitos

- Node.js 20+ (recomendado 22+).
- Navegador compatible con `MediaRecorder` y `getDisplayMedia` (Chrome/Edge/Brave).

## Ejecutar en local

```bash
npm install
npm run dev
```

Abrir `http://localhost:5173`.

## Build de produccion

```bash
npm run build
npm run preview
```

## Transcripcion y reportes (desacoplado)

El proyecto incluye un modulo separado en `services/transcription` para procesar audios/videos de reuniones.
Los resúmenes y reportes se generan con `gpt-5.4-mini`.

1. Configura las claves en entorno:

```bash
export OPENAI_API_KEY="tu_clave"        # necesaria para transcribir audio (Whisper)
export DASHSCOPE_API_KEY="sk-sp-..."    # opcional: usa Qwen (gratis) para resumenes
```

Si se configura `DASHSCOPE_API_KEY`, los resumenes y la limpieza de texto se generan
con Qwen3.5-plus via DashScope (Alibaba Cloud coding plan) en vez de OpenAI.

2. Ejecuta:

```bash
npm run transcribe -- /ruta/al/archivo.webm
```

Modo API (para integrarlo con la UI):

```bash
npm run transcribe:api
```

Variables utiles para la API de transcripcion:
- `TRANSCRIBE_MAX_UPLOAD_BYTES` (por defecto `2147483648`, ~2 GB)
- `TRANSCRIBE_CHUNK_SECONDS` (por defecto `480`)

O frontend + API a la vez:

```bash
npm run dev:all
```

Con Docker Compose (frontend + API):

```bash
export OPENAI_API_KEY="tu_clave"
export DASHSCOPE_API_KEY="sk-sp-..."  # opcional
docker compose up --build
```

Resultados:
- `services/transcription/out/<archivo>-<fecha>/transcript.txt`
- `services/transcription/out/<archivo>-<fecha>/speaker_turns.json`
- `services/transcription/out/<archivo>-<fecha>/report.json`
- `services/transcription/out/<archivo>-<fecha>/full_output.json`

## Nota

Si el navegador no permite audio del sistema, la app intentara grabar al menos el microfono.
Las grabaciones quedan guardadas en la base local del navegador (IndexedDB) del dispositivo/navegador donde se usan.
