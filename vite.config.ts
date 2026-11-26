import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

const proxy = { '/api/records': 'http://127.0.0.1:8094' };

// Ревизия попадает в сборку: git archive подставляет её в revision.txt (см. .gitattributes),
// локально в репозитории её берём из git, в остальных случаях — 'dev'.
function revision() {
  try {
    const stamped = readFileSync(new URL('./revision.txt', import.meta.url), 'utf8').trim();
    if (/^[0-9a-f]{7,40}$/.test(stamped)) return stamped.slice(0, 7);
  } catch { /* файла нет */ }
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

const rev = revision();

export default defineConfig({
  base: './',
  define: {
    __BUILD_REV__: JSON.stringify(rev),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [{
    name: 'emit-build-info',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.txt', source: rev });
    },
  }],
  server: { proxy },
  preview: { proxy },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: 'index.html', proto: 'proto.html' } },
  },
});
