import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    // Local dev: forward API calls to the Hono server so the browser
    // stays same-origin (no CORS needed, mirrors production hosting).
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
