import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// base './' makes the build work from any sub-path (GitHub Pages project sites,
// Netlify, Cloudflare Pages) without extra configuration.
//
// `npm run dev:lan` (mode "lan") serves over HTTPS with a self-signed
// certificate on every network interface, so friends on the same Wi-Fi can
// open it. Browsers only give a page the microphone (voice chat) over HTTPS
// or on localhost; plain http://192.168.x.x would leave them listening only.
export default defineConfig(({ mode }) => ({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  server: { port: 5173, host: mode === 'lan' ? true : undefined },
  plugins: mode === 'lan' ? [basicSsl()] : [],
}));
