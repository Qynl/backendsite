import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');

function serveSdk() {
  const send = (file, mime) => (req, res) => {
    res.setHeader('Content-Type', mime);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: 'aether-sdk',
    configureServer(server) {
      server.middlewares.use('/aether.js', send(path.join(root, 'aether.js'), 'text/javascript; charset=utf-8'));
      server.middlewares.use('/react.js', send(path.join(root, 'react.js'), 'text/javascript; charset=utf-8'));
      server.middlewares.use('/node.js', send(path.join(root, 'node.js'), 'text/javascript; charset=utf-8'));
      server.middlewares.use('/favicon.svg', send(path.join(root, 'favicon.svg'), 'image/svg+xml'));
    },
    closeBundle() {
      const out = path.join(dir, 'dist');
      try {
        fs.copyFileSync(path.join(root, 'aether.js'), path.join(out, 'aether.js'));
        fs.copyFileSync(path.join(root, 'react.js'), path.join(out, 'react.js'));
        fs.copyFileSync(path.join(root, 'node.js'), path.join(out, 'node.js'));
        fs.copyFileSync(path.join(root, 'favicon.svg'), path.join(out, 'favicon.svg'));
      } catch {}
    }
  };
}

export default defineConfig({
  plugins: [react(), serveSdk()],
  resolve: {
    alias: { '@aether': path.join(root, 'aether.js') }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    fs: { allow: [root] }
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true
  }
});
