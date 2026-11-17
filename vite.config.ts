import { defineConfig } from 'vite';

// base './' makes the build work from any sub-path (GitHub Pages project sites,
// Netlify, Cloudflare Pages) without extra configuration.
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  server: { port: 5173 },
});
