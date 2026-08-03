/**
 * Production server for Sixes.
 *
 * Serves the Vite build from dist/ and nothing else — the game is entirely
 * client side. Railway sets PORT; everything else has a sane default.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');

// Railway's healthcheck hits this before any traffic is routed, so it must not
// depend on the build being present.
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    build: existsSync(join(dist, 'index.html')) ? 'present' : 'missing',
    uptime: Math.round(process.uptime()),
  });
});

if (!existsSync(dist)) {
  console.error('sixes: dist/ is missing — run `npm run build` before starting.');
}

app.use(
  express.static(dist, {
    index: false,
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) {
        // A stale worker would pin users to an old build.
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      } else if (filePath.endsWith('index.html') || filePath.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${sep}assets${sep}`)) {
        // Vite fingerprints these, so they can be cached hard.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    },
  }),
);

// Single page: any other GET renders the shell.
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  const shell = join(dist, 'index.html');
  if (!existsSync(shell)) return res.status(503).send('Sixes is still building.');
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(shell);
});

const server = app.listen(port, host, () => {
  console.log(`sixes: listening on http://${host}:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
