import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Two test projects: backend modules run in Node, React components in jsdom.
export default defineConfig({
  plugins: [react()],
  esbuild: { jsx: 'automatic' },
  test: {
    projects: [
      {
        test: {
          name: 'backend',
          environment: 'node',
          include: ['services/**/*.test.mjs'],
        },
      },
      {
        extends: true,
        test: {
          name: 'frontend',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup.js'],
          include: ['src/**/*.test.{js,jsx}'],
        },
      },
    ],
  },
})
