import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console only calls /admin/*. In development they go to a local gateway; in Docker nginx
// forwards them (see nginx.conf), so the browser always talks to one origin and CORS is not needed.
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: { port: 3000, proxy: { '/admin': gateway } },
  preview: { port: 3000, proxy: { '/admin': gateway } },
});
