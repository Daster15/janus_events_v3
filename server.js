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
  const m = {
    '1s': 1, '5s': 5, '10s': 10, '30s': 30,
    '1m': 60, '2m': 120, '5m': 300, '15m': 900
  };
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
  // przyjmujemy typowe ścieżki hooków oraz "/"
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
      // listy pomocnicze
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

      // seria po S/H
      if (pathname === '/api/stats/series') {
        const { session, handle, from, to, bucket = '1m' } = query;
        if (!session || !handle || !from || !to) return badRequest(res, 'Missing session/handle/from/to');
        const step = parseBucket(bucket);
        pool.query(
          `WITH binned AS (
             SELECT
               to_timestamp(floor(extract(epoch from timestamp)/$3)*$3) AS ts,
               AVG(jitterlocal)  AS jitterlocal,
               AVG(jitterremote) AS jitterremote,
               AVG(rtt)          AS rtt,
               AVG(in_link_quality)        AS in_lq,
               AVG(in_media_link_quality)  AS in_mlq,
               AVG(out_link_quality)       AS out_lq,
               AVG(out_media_link_quality) AS out_mlq,
               SUM(lostlocal)    AS lostlocal,
               SUM(lostremote)   AS lostremote,
               SUM(bytessent)    AS sum_bytes_sent,
               SUM(bytesrecv)    AS sum_bytes_recv,
               SUM(packetssent)  AS packetssent,
               SUM(packetsrecv)  AS packetsrecv,
               SUM(nackssent)    AS nackssent,
               SUM(nacksrecv)    AS nacksrecv,
               AVG(bytes_sent_lastsec) AS avg_bytes_sent_lastsec,
               AVG(bytes_recv_lastsec) AS avg_bytes_recv_lastsec,
               SUM(retransmissions_recv) AS retransmissions_recv
             FROM stats
             WHERE session = $1 AND handle = $2
               AND timestamp >= $4::timestamptz AND timestamp <= $5::timestamptz
             GROUP BY 1
           )
           SELECT ts, jitterlocal, jitterremote, rtt,
                  in_lq, in_mlq, out_lq, out_mlq,
                  lostlocal, lostremote, packetssent, packetsrecv, nackssent, nacksrecv,
                  (sum_bytes_sent * 8.0) / $3 AS tx_bps,
                  (sum_bytes_recv * 8.0) / $3 AS rx_bps,
                  (avg_bytes_sent_lastsec * 8.0) AS tx_bps_inst,
                  (avg_bytes_recv_lastsec * 8.0) AS rx_bps_inst,
                  retransmissions_recv
           FROM binned
           ORDER BY ts ASC`,
          [session, handle, step, from, to]
        ).then(r => sendJson(res, 200, r.rows))
         .catch(e => { console.error('stats/series error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }

      // ostatnie eventy (ICE/DTLS/JSEP) po S/H
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

            // lista połączeń (sip_calls) + ostatni selected-pair dla danego handle
      if (pathname === '/api/sip/calls') {
        const { from, to, search } = query;
        const limit = Math.min(parseInt(query.limit || '200', 10), 1000);
        const wh = []; const vals = [];
        if (from) { vals.push(from); wh.push(`sc.created_at >= $${vals.length}::timestamptz`); }
        if (to)   { vals.push(to);   wh.push(`sc.created_at <= $${vals.length}::timestamptz`); }
        if (search) {
          vals.push(`%${search}%`);
          wh.push(`(sc.call_id ILIKE $${vals.length} OR sc.from_uri ILIKE $${vals.length} OR sc.to_uri ILIKE $${vals.length})`);
        }
        vals.push(limit);
        const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';

        const sql = `
          SELECT
            sc.call_id, sc.session, sc.handle, sc.from_uri, sc.to_uri, sc.direction, sc.created_at,
            sp.selected            AS sp_selected,
            sp.m[1]               AS sp_local,
            sp.m[2]               AS sp_local_type,
            sp.m[3]               AS sp_local_proto,
            sp.m[4]               AS sp_remote,
            sp.m[5]               AS sp_remote_type,
            sp.m[6]               AS sp_remote_proto
          FROM sip_calls sc
          LEFT JOIN LATERAL (
            SELECT
              sp.selected,
              regexp_match(
                sp.selected,
                '^\\s*([^ ]+)\\s+\\[([^,]+),([^\\]]+)\\]\\s+<->\\s+([^ ]+)\\s+\\[([^,]+),([^\\]]+)\\]'
              ) AS m
            FROM selectedpairs sp
            WHERE sp.session = sc.session AND sp.handle = sc.handle
            ORDER BY sp.timestamp DESC
            LIMIT 1
          ) sp ON TRUE
          ${where}
          ORDER BY sc.created_at DESC
          LIMIT $${vals.length}::int
        `;

        pool.query(sql, vals)
          .then(r => sendJson(res, 200, r.rows))
          .catch(e => { console.error('sip/calls error', e); sendJson(res, 500, { error: 'db_error' }); });
        return;
      }


      // szczegóły połączenia po call_id
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

      // seria po call_id (dla frontu)
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
              AVG(s.rtt)           AS rtt,
              AVG(s.in_link_quality)        AS in_lq,
              AVG(s.in_media_link_quality)  AS in_mlq,
              AVG(s.out_link_quality)       AS out_lq,
              AVG(s.out_media_link_quality) AS out_mlq,
              SUM(s.lostlocal)     AS lostlocal,
              SUM(s.lostremote)    AS lostremote,
              SUM(s.packetssent)   AS packetssent,
              SUM(s.packetsrecv)   AS packetsrecv,
              SUM(s.bytessent)     AS bytessent,
              SUM(s.bytesrecv)     AS bytesrecv,
              SUM(s.nackssent)     AS nackssent,
              SUM(s.nacksrecv)     AS nacksrecv,
              AVG(s.bytes_sent_lastsec) AS avg_bytes_sent_lastsec,
              AVG(s.bytes_recv_lastsec) AS avg_bytes_recv_lastsec,
              SUM(s.retransmissions_recv) AS retransmissions_recv
            FROM stats s
            JOIN sh ON s.session = sh.session AND s.handle = sh.handle
            WHERE s.timestamp >= $3::timestamptz AND s.timestamp <= $4::timestamptz
            GROUP BY 1
          )
          SELECT
            ts, base, lsr, jitterlocal, jitterremote, rtt, in_lq, in_mlq, out_lq, out_mlq,
            lostlocal, lostremote, packetssent, packetsrecv,
            bytessent, bytesrecv, nackssent, nacksrecv,
            (bytessent * 8.0) / $2 AS tx_bps,
            (bytesrecv * 8.0) / $2 AS rx_bps,
            (avg_bytes_sent_lastsec * 8.0) AS tx_bps_inst,
            (avg_bytes_recv_lastsec * 8.0) AS rx_bps_inst,
            retransmissions_recv
          FROM binned
          ORDER BY ts ASC
          `,
          [call_id, step, from, to]
        ).then(r => sendJson(res, 200, r.rows))
         .catch(e => { console.error('series/by-call error', e); sendJson(res, 500, { error: 'db_error' }); });
        // console.log(res)
        return;
      }

      // zdarzenia jako flagi po call_id (ICE/DTLS/JSEP + opcjonalnie SLOWLINK)
      if (pathname === '/api/events/by-call') {
        const { call_id, from, to } = query;
        if (!call_id || !from || !to) return badRequest(res, 'Missing call_id/from/to');

        (async () => {
          try {
            const sh = await pool.query(
              `SELECT session, handle FROM sip_calls
               WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [call_id]
            );
            if (!sh.rows.length) return sendJson(res, 404, { error: 'not_found' });
            const { session, handle } = sh.rows[0];

            const base = await pool.query(
              `SELECT timestamp AS ts, 'ICE' AS type, state AS value, NULL::text AS detail
                 FROM ice WHERE session=$1 AND handle=$2 AND timestamp BETWEEN $3::timestamptz AND $4::timestamptz
               UNION ALL
               SELECT timestamp, 'DTLS', state, NULL
                 FROM dtls WHERE session=$1 AND handle=$2 AND timestamp BETWEEN $3::timestamptz AND $4::timestamptz
               UNION ALL
               SELECT timestamp, 'JSEP', CASE WHEN offer THEN 'offer' ELSE 'answer' END, LEFT(sdp, 160)
                 FROM sdps WHERE session=$1 AND handle=$2 AND timestamp BETWEEN $3::timestamptz AND $4::timestamptz
               ORDER BY ts ASC`,
              [session, handle, from, to]
            );

            let events = base.rows;

            // opcjonalnie: slowlink_threshold → tabela slowlinks(payload jsonb)
            try {
              const sl = await pool.query(
                `SELECT timestamp AS ts, 'SLOWLINK' AS type, NULL::text AS value, LEFT(payload::text, 200) AS detail
                 FROM slowlinks
                 WHERE session=$1 AND handle=$2 AND timestamp BETWEEN $3::timestamptz AND $4::timestamptz
                 ORDER BY ts ASC`,
                [session, handle, from, to]
              );
              events = events.concat(sl.rows);
            } catch (err) {
              if (err.code !== '42P01') console.warn('slowlinks query warn:', err.message);
            }

            sendJson(res, 200, { session, handle, events });
          } catch (e) {
            console.error('events/by-call error', e);
            sendJson(res, 500, { error: 'db_error' });
          }
        })();
        return;
      }

      // SIP ladder po call_id (plugins.event: {"sip":"...","event":"sip-in|sip-out"})
      // === SIP FLOW by-call (bez JSON operatorów w SQL) ===
if (pathname === '/api/sip/flow/by-call') {
  const call_id = query.call_id && String(query.call_id);
  if (!call_id) return badRequest(res, 'Missing call_id');

  // opcjonalne: from, to, limit
  const from = query.from ? String(query.from) : null;
  const to   = query.to   ? String(query.to)   : null;
  const limit = Math.min(parseInt(query.limit || '2000', 10), 10000);

  (async () => {
    try {
      // 1) znajdź session/handle dla call_id
      const sh = await pool.query(
        `SELECT session, handle, from_uri, to_uri
           FROM sip_calls
          WHERE call_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [call_id]
      );
      if (!sh.rows.length) return sendJson(res, 404, { error: 'not_found' });

      const { session, handle, from_uri, to_uri } = sh.rows[0];

      // 2) pobierz pluginy 'janus.plugin.sip' dla S/H (czas opcjonalny), sort ASC
      const vals = [session, handle];
      const wh = ['session = $1', 'handle = $2', `plugin = 'janus.plugin.sip'`];
      if (from) { vals.push(from); wh.push(`timestamp >= $${vals.length}::timestamptz`); }
      if (to)   { vals.push(to);   wh.push(`timestamp <= $${vals.length}::timestamptz`); }
      vals.push(limit);

      const sql = `
        SELECT event, timestamp
          FROM plugins
         WHERE ${wh.join(' AND ')}
         ORDER BY timestamp ASC
         LIMIT $${vals.length}::int
      `;
      const pr = await pool.query(sql, vals);

      // 3) zmapuj → tylko rekordy z właściwym Call-ID
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const callRe = new RegExp(`(^|\\r?\\n)\\s*Call-ID\\s*:\\s*${esc(call_id)}(\\r?\\n|$)`, 'i');

      const messages = [];
      for (const row of pr.rows) {
        let ev = row.event;
        if (typeof ev === 'string') {
          try { ev = JSON.parse(ev); } catch { ev = null; }
        }
        if (!ev || typeof ev !== 'object') continue;

        // czy to należy do wybranego call_id?
        let belongs = false;
        if (ev['call-id'] && String(ev['call-id']) === call_id) {
          belongs = true;
        } else if (ev.sip && typeof ev.sip === 'string' && callRe.test(ev.sip)) {
          belongs = true;
        }
        if (!belongs) continue;

        // kierunek
        const dir = ev.event === 'sip-in' ? 'in' : ev.event === 'sip-out' ? 'out' : 'in';

        // etykieta + CSeq
        let label = 'SIP';
        let cseq = null;
        if (ev.sip && typeof ev.sip === 'string' && ev.sip.length) {
          const lines = ev.sip.split(/\r?\n/);
          const start = (lines[0] || '').trim();
          if (/^SIP\/2\.0/i.test(start)) {
            // odpowiedź, np. "SIP/2.0 200 OK"
            label = start;
          } else {
            // metoda, np. "INVITE sip:...."
            label = start.split(/\s+/)[0] || 'SIP';
          }
          const mCseq = ev.sip.match(/^\s*CSeq:\s*([^\r\n]+)/mi);
          if (mCseq) cseq = mCseq[1].trim();
        } else if (ev.event) {
          label = String(ev.event);
          if (ev['call-id']) cseq = `call-id:${ev['call-id']}`;
        }

        messages.push({
          ts: new Date(row.timestamp).toISOString(),
          dir,
          kind: 'request',
          label,
          cseq
        });
      }

      // 4) uczestnicy (ładne podpisy)
      const participants = [
        'Janus',
        (to_uri || from_uri || 'SIP peer')
      ];

      return sendJson(res, 200, { participants, messages });
    } catch (e) {
      console.error('sip/flow/by-call error:', e);
      return sendJson(res, 500, { error: 'db_error' });
    }
  })();
  return;
}


      // (opcjonalnie) SIP ladder po session/handle
      if (pathname === '/api/sip/flow/by-sh') {
        const { session, handle, from, to } = query;
        const limit = Math.min(parseInt(query.limit || '800', 10), 5000);
        if (!session || !handle) return badRequest(res, 'Missing session/handle');

        (async () => {
          try {
            const vals = [session, handle];
            const wh = [
              `p.session = $1`,
              `p.handle  = $2`,
              `p.plugin  = 'janus.plugin.sip'`
            ];
            if (from) { vals.push(from); wh.push(`p.timestamp >= $${vals.length}::timestamptz`); }
            if (to)   { vals.push(to);   wh.push(`p.timestamp <= $${vals.length}::timestamptz`); }
            vals.push(limit);

            const rows = (await pool.query(
              `SELECT p.timestamp AS ts, p.event
                 FROM plugins p
                WHERE ${wh.join(' AND ')}
                ORDER BY p.timestamp ASC
                LIMIT $${vals.length}::int`,
              vals
            )).rows;

            function parseSipRaw(raw) {
              const out = { method:null, code:null, reason:null, from:null, to:null, cseq:null };
              if (typeof raw !== 'string') return out;
              const lines = raw.split(/\r?\n/);
              if (!lines.length) return out;
              const start = lines[0].trim();
              let m = /^SIP\/2\.0\s+(\d{3})\s+(.*)$/.exec(start);
              if (m) { out.code = parseInt(m[1],10); out.reason = m[2]; }
              else {
                m = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(start);
                if (m) out.method = m[1];
              }
              for (const L of lines) {
                const l = L.toLowerCase();
                if (l.startsWith('from:')) out.from = L.split(':',2)[1]?.trim();
                if (l.startsWith('to:')) out.to = L.split(':',2)[1]?.trim();
                if (l.startsWith('cseq:')) out.cseq = L.split(':',2)[1]?.trim();
              }
              return out;
            }

            const messages = [];
            for (const r of rows) {
              try {
                const ev = JSON.parse(r.event);
                const raw = ev?.sip;
                const dir =
                  ev?.event === 'sip-in'  ? 'in'  :
                  ev?.event === 'sip-out' ? 'out' :
                  (ev?.direction === 'incoming' ? 'in' : ev?.direction === 'outgoing' ? 'out' : 'out');

                const p = parseSipRaw(raw);
                const label = p.method ? p.method : (p.code ? (p.reason ? `${p.code} ${p.reason}` : String(p.code)) : 'SIP');

                messages.push({
                  ts: r.ts, dir, kind: p.method ? 'request' : 'response',
                  label, from_uri: p.from || null, to_uri: p.to || null, cseq: p.cseq || null
                });
              } catch (_) {}
            }

            sendJson(res, 200, { session, handle, participants: ['Janus','SIP Peer'], messages });
          } catch (e) {
            console.error('sip/flow/by-sh error', e);
            sendJson(res, 500, { error: 'db_error' });
          }
        })();
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
        if (body.length > (config.limits?.bodyBytes || 256*1024)) {
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
  server.on('clientError', (err, socket) => {
    console.warn('clientError:', err?.message);
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
  });

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
