// server.js
const http = require('http');
const url = require('url');
const config = require('./settings');
const { ensureConnected, shutdown } = require('./db');
const { requireBasicAuth } = require('./auth');
const { handleEvent } = require('./eventHandler');

(async () => {
  try {
    await ensureConnected();
  } catch (e) {
    console.error('Error connecting to DB:', e);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const { pathname } = url.parse(req.url || '/', false);
    const addr = req.socket.remoteAddress;
    console.log(`[REQ] ${req.method} ${pathname} from ${addr}`);

    // Healthcheck bez auth
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Akceptujemy każdy POST (Janus potrafi wysyłać na "/")
    if (req.method !== 'POST') {
      console.log('[SKIP] Not POST -> 405');
      res.writeHead(405);
      res.end();
      return;
    }

    // Basic Auth (jeśli włączony w settings.js)
    if (!requireBasicAuth(req, res)) {
      console.log(`[AUTH] 401 for ${addr}`);
      return; // res już zakończony w requireBasicAuth
    }

    // Limit rozmiaru body
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > config.limits.bodyBytes) {
        console.warn(`[LIMIT] Body too large (${body.length} bytes) -> 413`);
        res.writeHead(413);
        res.end();
        req.socket.destroy();
      }
    });

    req.on('end', async () => {
      try {
        if (!body) {
          console.warn('[WARN] Empty body -> 400');
          res.writeHead(400);
          res.end('empty body');
          return;
        }
        const json = JSON.parse(body);
        console.log('[OK] JSON parsed, passing to handleEvent');
        await handleEvent(json);
        res.writeHead(204); // No Content
        res.end();
      } catch (e) {
        console.error('[ERR] Error handling request:', e);
        res.writeHead(400);
        res.end();
      }
    });
  });

  server.on('error', (err) => {
    console.error('HTTP server error:', err);
    process.exit(1);
  });

  // (opcjonalnie) ładniejsze błędy klienta
  server.on('clientError', (err, socket) => {
    console.warn('clientError:', err?.message);
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (_) {}
  });

  server.listen(config.http.port, config.http.host, () => {
    console.log(`Listening on http://${config.http.host}:${config.http.port}`);
  });

  const graceful = async (sig) => {
    console.log(`Received ${sig}, shutting down...`);
    server.close(async () => {
      await shutdown();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => graceful('SIGINT'));
  process.on('SIGTERM', () => graceful('SIGTERM'));
})();
