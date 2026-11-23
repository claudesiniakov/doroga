import { defineConfig } from 'vite';

const proxy = { '/api/records': 'http://127.0.0.1:8094' };

export default defineConfig({
  base: './',
  server: { proxy },
  preview: { proxy },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: 'index.html', proto: 'proto.html' } },
  },
});
