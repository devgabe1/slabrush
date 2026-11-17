import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';
import { RoomDirectory } from './src/net/roomDirectory.ts';

// base './' makes the build work from any sub-path (GitHub Pages project sites,
// Netlify, Cloudflare Pages) without extra configuration.
//
// `npm run dev:lan` (mode "lan") serves over HTTPS with a self-signed
// certificate on every network interface, so friends on the same Wi-Fi can
// open it. Browsers only give a page the microphone (voice chat) over HTTPS
// or on localhost; plain http://192.168.x.x would leave them listening only.

/**
 * The list of rooms on this network (see src/net/roomDirectory.ts), served at
 * /__rooms by the dev and preview servers: GET lists, POST announces or
 * withdraws. A static build has no such endpoint, and the game copes.
 */
function roomDirectory(): Plugin {
  const dir = new RoomDirectory();
  const now = () => performance.now() / 1000;
  type Req = { method?: string; on(ev: string, fn: (chunk?: unknown) => void): void };
  type Res = { statusCode: number; setHeader(k: string, v: string): void; end(body?: string): void };
  const handle = (req: Req, res: Res) => {
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET') return reply(200, { rooms: dir.list(now()) });
    if (req.method !== 'POST') return reply(405, { error: 'method' });
    let raw = '';
    req.on('data', (c) => { raw += String(c); if (raw.length > 2048) raw = 'x'.repeat(4096); }); // tiny bodies only
    req.on('end', () => {
      let body: unknown = null;
      try { if (raw.length <= 2048) body = JSON.parse(raw); } catch { /* rejected below */ }
      const ok = dir.post(body, now());
      reply(ok ? 200 : 400, { ok });
    });
  };
  // A block body on purpose: a function returned from configureServer would be run by Vite as a post hook.
  const mount = (server: { middlewares: { use(path: string, fn: (req: Req, res: Res) => void): void } }): void => {
    server.middlewares.use('/__rooms', handle);
  };
  return { name: 'slabrush-room-directory', configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => ({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  server: { port: 5173, host: mode === 'lan' ? true : undefined },
  preview: { host: mode === 'lan' ? true : undefined },
  plugins: [roomDirectory(), ...(mode === 'lan' ? [basicSsl()] : [])],
}));
