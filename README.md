# Grabador de Reuniones

App web (React + Vite) para grabar reuniones desde el navegador, transcribirlas con
hablantes y sacar un acta (resumen, participantes, decisiones, tareas, dudas abiertas).

## Cómo funciona

- **Grabación**: pantalla + audio (o solo audio). Mezcla audio del sistema y micrófono.
  Pausar/reanudar, vista previa y descarga `.webm`. Historial en IndexedDB.
- **Transcripción**: al parar, el archivo entero va a Soniox (`stt-async-v6`) en una sola
  petición (sin trocear) y luego se resume. El botón "Transcribir" sirve para reprocesar.
- **Resumen**: OpenAI `gpt-6-luna` sin reasoning, con JSON schema estricto.
- **Vocabulario**: `server/vocabulary.txt` (un término por línea) se pasa a Soniox como
  contexto para que acierte nombres propios y jerga.

Coste aproximado: $0,10/h de audio; el resumen < 1 céntimo.

## Configuración

`.env` en la raíz:

```
SONIOX_API_KEY=...
OPENAI_API_KEY=...
# SUMMARY_MODEL=gpt-6-luna
```

## Ejecutar

```bash
docker compose up -d --build     # http://localhost:5173
# o sin Docker:
npm install && npm run dev:all
```

`npm test` · `npm run lint`

## Linux + Wayland (Hyprland)

Si Chrome/Teams solo dejan compartir pestañas, el portal de captura no está activo:
`systemctl --user restart xdg-desktop-portal-hyprland xdg-desktop-portal`.
