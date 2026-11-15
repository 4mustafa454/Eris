import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The harness allows browser origins localhost:5173 / 127.0.0.1:5173 (harness/app/main.py), so keep this port.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
})
