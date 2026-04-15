import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const transcriptionApiUrl =
  globalThis.process?.env?.TRANSCRIPTION_API_URL || 'http://localhost:8787'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/transcriptions': {
        target: transcriptionApiUrl,
        changeOrigin: true,
      },
      '/api/reports/regenerate': {
        target: transcriptionApiUrl,
        changeOrigin: true,
      },
      '/api/exports/meeting-zip': {
        target: transcriptionApiUrl,
        changeOrigin: true,
      },
      '/health': {
        target: transcriptionApiUrl,
        changeOrigin: true,
      },
    },
  },
})
