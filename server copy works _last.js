// server.js
'use strict';

const http = require('http');
const url = require('url');
const config = require('./settings');
const { ensureConnected, shutdown, pool } = require('./db');
const { requireBasicAuth } = require('./auth');
const { handleEvent } = require('./eventHandler');

/* ----------------- helpers ----------------- */
function send(res, status, body, headers = {}) {
  const h = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...headers
  };
  res.writeHead(status, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function sendJson(res, status, obj) { send(res, status, obj); }
function badRequest(res, msg = 'bad request') { sendJson(res, 400, { error: msg }); }
function notFound(res) { send(res, 404, ''); }
function parseBucket(bucket) {
  const m = { '1m': 60, '5m': 300, '15m': 900 };
  return m[String(bucket || '1m')] || 60;
}
function maskHeaders(h) {
  const c = { ...h };
  if (c.authorization) c.authorization = '[REDACTED]';
  if (c.cookie) c.cookie = '[REDACTED]';
  return c;
}
function trunc(s, n = 4000) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…(truncated)' : s;
}
function isApiPath(pathname) { return pathname.startsWith('/api/'); }
function isHookPath(pathname) {
  // jawnie: /hooks/janus, /janus; oraz domyślnie łapiemy też "/"
  return pathname === '/' || pathname === '/hooks/janus' || pathname === '/janus' || pathname === '/events';
}

/* -------------- start server -------------- */
(async () => {
  try { await ensureConnected(); }
  catch (e) { console.error('Error connecting to DB:', e); process.exit(1); }

  const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

    const { pathname, query } = url.parse(req.url || '/', true);
    const addr = req.socket.remoteAddress;
    console.log(`[REQ] ${req.method} ${pathname} from ${addr}`);

    /* -------- Health (bez autoryzacji) -------- */
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
      pool.query('SELECT 1').then(
        () => sendJson(res, 200, { ok: true }),
        err => sendJson(res, 500, { ok: false, error: err.message })
      );
      return;
    }

    /* ================= REST API (GET) ================= */
    if (req.method === 'GET' && isApiPath(pathname)) {
      if (pathname === '/api/sessions') {
        pool.query(
          `SELECT DISTINCT session FROM handles
           WHERE session IS NOT NULL
           ORDER BY session DESC
           LIMIT 1000`
        ).then(r => sendJson(res, 200, r.rows))
         .catch(e => { console.error('sessions error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      if (pathname === '/api/handles') {
        const { session } = query;
        if (!session) return badRequest(res, 'Missing session');
        pool.query(
          `SELECT DISTINCT handle FROM handles
           WHERE session = $1 AND handle IS NOT NULL
           ORDER BY handle DESC
           LIMIT 1000`, [session]
        ).then(r => sendJson(res, 200, r.rows))
         .catch(e => { console.error('handles error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      if (pathname === '/api/stats/series') {
        const { session, handle, from, to, bucket = '1m' } = query;
        if (!session || !handle || !from || !to) return badRequest(res, 'Missing session/handle/from/to');
        const step = parseBucket(bucket);
        pool.query(
          `WITH binned AS (
             SELECT
               to_timestamp(floor(extract(epoch from timestamp)/$3)*$3) AS ts,
               AVG(jitterlocal) AS jitterlocal,
               AVG(jitterremote) AS jitterremote,
               SUM(lostlocal) AS lostlocal,
               SUM(lostremote) AS lostremote,
               SUM(bytessent) AS sum_bytes_sent,
               SUM(bytesrecv) AS sum_bytes_recv,
               SUM(packetssent) AS packetssent,
               SUM(packetsrecv) AS packetsrecv,
               SUM(nackssent) AS nackssent,
               SUM(nacksrecv) AS nacksrecv
             FROM stats
             WHERE session = $1 AND handle = $2
               AND timestamp >= $4::timestamptz AND timestamp <= $5::timestamptz
             GROUP BY 1
           )
           SELECT ts, jitterlocal, jitterremote, lostlocal, lostremote,
                  packetssent, packetsrecv, nackssent, nacksrecv,
                  (sum_bytes_sent * 8.0) / $3 AS tx_bps,
                  (sum_bytes_recv * 8.0) / $3 AS rx_bps
           FROM binned
           ORDER BY ts ASC`,
          [session, handle, step, from, to]
        ).then(r => sendJson(res, 200, r.rows))
         .catch(e => { console.error('stats/series error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      if (pathname === '/api/events/recent') {
        const { session, handle } = query;
        const limit = Math.min(parseInt(query.limit || '50', 10), 500);
        if (!session || !handle) return badRequest(res, 'Missing session/handle');
        pool.query(
          `SELECT timestamp AS time, 'ICE' AS type, state, NULL::text AS detail
             FROM ice WHERE session=$1 AND handle=$2
           UNION ALL
           SELECT timestamp, 'DTLS', state, NULL
             FROM dtls WHERE session=$1 AND handle=$2
           UNION ALL
           SELECT timestamp, 'JSEP',
                  CASE WHEN offer THEN 'offer' ELSE 'answer' END,
                  LEFT(sdp, 160)
             FROM sdps WHERE session=$1 AND handle=$2
           ORDER BY time DESC
           LIMIT $3::int`,
          [session, handle, limit]
        ).then(r => sendJson(res, 200, r.rows))
         .catch(e => { console.error('events/recent error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      if (pathname === '/api/sip/calls') {
        const { from, to, search } = query;
        const limit = Math.min(parseInt(query.limit || '200', 10), 1000);
        const wh = []; const vals = [];
        if (from) { vals.push(from); wh.push(`created_at >= $${vals.length}::timestamptz`); }
        if (to)   { vals.push(to);   wh.push(`created_at <= $${vals.length}::timestamptz`); }
        if (search) { vals.push(`%${search}%`); wh.push(`(call_id ILIKE $${vals.length} OR from_uri ILIKE $${vals.length} OR to_uri ILIKE $${vals.length})`); }
        vals.push(limit);
        const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
        const sql = `
          SELECT call_id, session, handle, from_uri, to_uri, direction, created_at
          FROM sip_calls
          ${where}
          ORDER BY created_at DESC
          LIMIT $${vals.length}::int
        `;
        pool.query(sql, vals)
          .then(r => sendJson(res, 200, r.rows))
          .catch(e => { console.error('sip/calls error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      if (pathname.startsWith('/api/sip/call/')) {
        const call_id = decodeURIComponent(pathname.replace('/api/sip/call/', ''));
        pool.query(
          `SELECT call_id, session, handle, from_uri, to_uri, direction, created_at
             FROM sip_calls WHERE call_id = $1
             ORDER BY created_at DESC LIMIT 1`,
          [call_id]
        ).then(r => {
          if (!r.rows.length) return sendJson(res, 404, { error: 'not_found' });
          sendJson(res, 200, r.rows[0]);
        }).catch(e => { console.error('sip/call error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      if (pathname === '/api/stats/series/by-call') {
        const { call_id, from, to, bucket = '1m' } = query;
        if (!call_id || !from || !to) return badRequest(res, 'Missing call_id/from/to');
        const step = parseBucket(bucket);
        pool.query(
          `
          WITH sh AS (
            SELECT session, handle
            FROM sip_calls
            WHERE call_id = $1
            ORDER BY created_at DESC
            LIMIT 1
          ),
          binned AS (
            SELECT
              to_timestamp(floor(extract(epoch from s.timestamp)/$2)*$2) AS ts,
              AVG(s.base)          AS base,
              AVG(s.lsr)           AS lsr,
              AVG(s.jitterlocal)   AS jitterlocal,
              AVG(s.jitterremote)  AS jitterremote,
              SUM(s.lostlocal)     AS lostlocal,
              SUM(s.lostremote)    AS lostremote,
              SUM(s.packetssent)   AS packetssent,
              SUM(s.packetsrecv)   AS packetsrecv,
              SUM(s.bytessent)     AS bytessent,
              SUM(s.bytesrecv)     AS bytesrecv,
              SUM(s.nackssent)     AS nackssent,
              SUM(s.nacksrecv)     AS nacksrecv
            FROM stats s
            JOIN sh ON s.session = sh.session AND s.handle = sh.handle
            WHERE s.timestamp >= $3::timestamptz AND s.timestamp <= $4::timestamptz
            GROUP BY 1
          )
          SELECT
            ts, base, lsr, jitterlocal, jitterremote,
            lostlocal, lostremote, packetssent, packetsrecv,
            bytessent, bytesrecv, nackssent, nacksrecv,
            (bytessent * 8.0) / $2 AS tx_bps,
            (bytesrecv * 8.0) / $2 AS rx_bps
          FROM binned
          ORDER BY ts ASC
          `,
          [call_id, step, from, to]
        ).then(r => sendJson(res, 200, r.rows))
         .catch(e => { console.error('series/by-call error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      // nieznane /api/*
      return notFound(res);
    }

    /* ================= Webhook z Janusa (POST) =================
       Akceptujemy POST na dowolnej ścieżce (/, /hooks/janus, /janus, /events).
       BasicAuth tylko dla webhooków. */
    if (req.method === 'POST' && isHookPath(pathname)) {
      const hdrs = maskHeaders(req.headers);
      console.log(`[HOOK] ${pathname} from ${addr} headers=`, hdrs);

      if (!requireBasicAuth(req, res)) {
        console.log(`[AUTH] 401 for ${addr} on ${pathname}`);
        return; // res już zakończona w requireBasicAuth
      }

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
          console.log(`[HOOK] body(${body.length}B) ${trunc(body)}`);
          const json = JSON.parse(body);
          await handleEvent(json);
          res.writeHead(204); // No Content
          res.end();
        } catch (e) {
          console.error('[ERR] Error handling hook:', e);
          res.writeHead(400);
          res.end();
        }
      });

      return;
    }

    // inne POST-y (np. coś spoza API) → 405
    if (req.method === 'POST') {
      console.log('[SKIP] POST not a hook -> 405');
      res.writeHead(405);
      res.end();
      return;
    }

    // GET/HEAD poza API/health → 404
    return notFound(res);
  });

  server.on('error', (err) => { console.error('HTTP server error:', err); process.exit(1); });
  server.on('clientError', (err, socket) => { console.warn('clientError:', err?.message); try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });

  server.listen(config.http.port, config.http.host, () => {
    console.log(`Listening on http://${config.http.host}:${config.http.port}`);
  });

  const graceful = async (sig) => {
    console.log(`Received ${sig}, shutting down...`);
    server.close(async () => { await shutdown(); process.exit(0); });
  };
  process.on('SIGINT', () => graceful('SIGINT'));
  process.on('SIGTERM', () => graceful('SIGTERM'));
})();
