import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  esbuild: { jsx: 'automatic' },
  test: {
    root: import.meta.dirname,
    environment: 'jsdom',
    globals: true,
    setupFiles: [`${import.meta.dirname}/src/test/setup.js`],
    include: ['src/**/*.test.{js,jsx}'],
  },
})
