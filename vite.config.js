import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiUrl = globalThis.process?.env?.API_URL || 'http://localhost:8787'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: apiUrl, changeOrigin: true },
    },
  },
})
