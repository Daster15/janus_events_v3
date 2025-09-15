'use strict';

/**
 * eventHandler.js
 *  - zapisuje zdarzenia Janusa do Postgresa (pool z ./db)
 *  - normalizuje timestamp (./utils: toDate)
 *  - obsługuje slowlink/slowlink_threshold (tabela slowlinks)
 *  - mapuje janus.plugin.sip -> sip_calls (po SIP Call-ID)
 */

const { pool } = require('./db');
const { toDate } = require('./utils');

/* ------------ helpers ------------- */

// wykrycie pól slowlink w payloadzie
function hasSlowlink(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    obj.slowlink !== undefined ||
    obj.slowlink_threshold !== undefined ||
    obj['slowlink-threshold'] !== undefined
  );
}

// bezpieczny insert do slowlinks (jeśli nie ma tabeli, logujemy ostrzeżenie)
async function saveSlowlink(sessionId, handleId, payload, ts) {
  try {
    await pool.query(
      'INSERT INTO slowlinks (session, handle, payload, timestamp) VALUES ($1, $2, $3, $4)',
      [sessionId ?? null, handleId ?? null, JSON.stringify(payload ?? {}), ts]
    );
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[slowlinks] brak tabeli slowlinks – uruchom migrację, aby włączyć zapis slowlink');
    } else {
      console.error('[slowlinks] DB error:', err.message);
    }
  }
}

// mapowanie SIP Call-ID dla janus.plugin.sip → sip_calls
async function saveSipCallMap(sessionId, handleId, data, ts) {
  const callId =
    data?.call_id ??
    data?.['call-id'] ??
    data?.headers?.['Call-ID'] ??
    data?.headers?.['call-id'] ??
    data?.sip_call_id ??
    null;

  if (!callId) return;

  const fromUri =
    data?.from ?? data?.from_uri ?? data?.caller ?? null;
  const toUri =
    data?.to ?? data?.to_uri ?? data?.callee ?? null;

  const direction =
    data?.incoming === true ? 'in' :
    data?.outgoing === true ? 'out' :
    (data?.direction ?? null);

  try {
    await pool.query(
      `INSERT INTO sip_calls (session, handle, call_id, from_uri, to_uri, direction, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (call_id) DO UPDATE
         SET session = EXCLUDED.session,
             handle  = EXCLUDED.handle,
             direction = COALESCE(sip_calls.direction, EXCLUDED.direction)`,
      [sessionId ?? null, handleId ?? null, callId, fromUri, toUri, direction, ts]
    );
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[sip_calls] brak tabeli sip_calls – uruchom migrację, aby włączyć mapowanie SIP');
    } else {
      console.error('[sip_calls] DB error:', err.message);
    }
  }
}

/* ------------ główna funkcja ------------- */

async function handleEvent(payload) {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      // przetwarzamy sekwencyjnie, aby zachować kolejność
      await handleEvent(item);
    }
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  const json = payload;
  const ts = toDate(json.timestamp);            // ważne: normalizacja (s/ms/µs/ns → Date)
  const q = (text, values) => pool.query(text, values);

  try {
    switch (json.type) {
      case 1: { // Session event
        const sessionId = json.session_id ?? null;
        const event = json.event?.name ?? null;
        await q(
          'INSERT INTO sessions (session, event, timestamp) VALUES ($1, $2, $3)',
          [sessionId, event, ts]
        );
        break;
      }

      case 2: { // Handle event
        const sessionId = json.session_id ?? null;
        const handleId = json.handle_id ?? null;
        const event = json.event?.name ?? null;
        const plugin = json.event?.plugin ?? null;
        await q(
          'INSERT INTO handles (session, handle, event, plugin, timestamp) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, handleId, event, plugin, ts]
        );
        break;
      }

      case 8: { // JSEP event
        const sessionId = json.session_id ?? null;
        const handleId = json.handle_id ?? null;
        const remote = json.event?.owner === 'remote';
        const offer = json.event?.jsep?.type === 'offer';
        const sdp = json.event?.jsep?.sdp ?? null;
        await q(
          'INSERT INTO sdps (session, handle, remote, offer, sdp, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
          [sessionId, handleId, remote, offer, sdp, ts]
        );
        break;
      }

      case 16: { // WebRTC events (ICE/selected-pair/DTLS/connection)
        const sessionId = json.session_id ?? null;
        const handleId = json.handle_id ?? null;
        const streamId = json.event?.stream_id ?? null;
        const componentId = json.event?.component_id ?? null;

        if (json.event?.ice != null) {
          const state = String(json.event.ice);
          await q(
            'INSERT INTO ice (session, handle, stream, component, state, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
            [sessionId, handleId, streamId, componentId, state, ts]
          );
        } else if (json.event?.['selected-pair'] != null) {
          const pair = String(json.event['selected-pair']);
          await q(
            'INSERT INTO selectedpairs (session, handle, stream, component, selected, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
            [sessionId, handleId, streamId, componentId, pair, ts]
          );
        } else if (json.event?.dtls != null) {
          const state = String(json.event.dtls);
          await q(
            'INSERT INTO dtls (session, handle, state, timestamp) VALUES ($1, $2, $3, $4)',
            [sessionId, handleId, state, ts]
          );
        } else if (json.event?.connection != null) {
          const state = String(json.event.connection);
          await q(
            'INSERT INTO connections (session, handle, state, timestamp) VALUES ($1, $2, $3, $4)',
            [sessionId, handleId, state, ts]
          );
        } else {
          console.error('Unsupported WebRTC event?', json.event);
        }
        break;
      }

      case 32: { // Media/Stats
  const sessionId = json.session_id ?? null;
  const handleId  = json.handle_id ?? null;
  const subtype   = json.subtype ?? null;             // NEW: top-level
  const e         = json.event || {};
  const medium    = e.media ?? null;

  if (e.receiving !== undefined && e.receiving !== null) {
    const receiving = e.receiving === true;
    await q(
      'INSERT INTO media (session, handle, medium, receiving, timestamp) VALUES ($1, $2, $3, $4, $5)',
      [sessionId, handleId, medium, receiving, ts]
    );
    break;
  }

  if (e.base !== undefined && e.base !== null) {
    // mapowanie wg podanego eventu
    const mid      = e.mid ?? null;
    const mindex   = e.mindex ?? null;
    const codec    = e.codec ?? null;

    const rtt      = e.rtt ?? null;
    const rtt_ntp  = e['rtt-values']?.ntp  ?? null;
    const rtt_lsr  = e['rtt-values']?.lsr  ?? null;
    const rtt_dlsr = e['rtt-values']?.dlsr ?? null;

    const in_lq    = e['in-link-quality']         ?? null;
    const in_mlq   = e['in-media-link-quality']   ?? null;
    const out_lq   = e['out-link-quality']        ?? null;
    const out_mlq  = e['out-media-link-quality']  ?? null;

    const pkt_recv = e['packets-received']  ?? null;
    const pkt_sent = e['packets-sent']      ?? null;

    const by_recv  = e['bytes-received']    ?? null;
    const by_sent  = e['bytes-sent']        ?? null;
    const by_recv1 = e['bytes-received-lastsec'] ?? null; // per-second instant
    const by_sent1 = e['bytes-sent-lastsec']     ?? null;

    const nacks_recv = e['nacks-received']  ?? null;
    const nacks_sent = e['nacks-sent']      ?? null;

    const retr_recv  = e['retransmissions-received'] ?? null;

    await q(
      `INSERT INTO stats
       (session, handle, subtype, mid, mindex, codec, medium,
        base, lsr, lostlocal, lostremote, jitterlocal, jitterremote,
        packetssent, packetsrecv, bytessent, bytesrecv, nackssent, nacksrecv,
        rtt, rtt_ntp, rtt_lsr, rtt_dlsr,
        in_link_quality, in_media_link_quality, out_link_quality, out_media_link_quality,
        bytes_sent_lastsec, bytes_recv_lastsec, retransmissions_recv,
        timestamp)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,
        $24,$25,$26,$27,
        $28,$29,$30,
        $31)`,
      [
        sessionId, handleId, subtype, mid, mindex, codec, medium,
        e.base ?? null, e.lsr ?? null,                    // UWAGA: e.lsr może nie występować w tym evencie
        e.lost ?? null, e['lost-by-remote'] ?? null,
        e['jitter-local'] ?? null, e['jitter-remote'] ?? null,
        pkt_sent, pkt_recv, by_sent, by_recv, nacks_sent, nacks_recv,
        rtt, rtt_ntp, rtt_lsr, rtt_dlsr,
        in_lq, in_mlq, out_lq, out_mlq,
        by_sent1, by_recv1, retr_recv,
        ts
      ]
    );
    break;
  }

  console.error('Unsupported media event?');
  break;
}


      case 64:   // Plugin
      case 128: { // Transport
        const sessionId = json.session_id ?? null;
        const handleId = json.handle_id ?? null;
        const plugin = json.event?.plugin ?? null;
        const data = json.event?.data ?? null;
        const eventStr = JSON.stringify(data ?? null);

        // zapis do tabeli plugins/transports (kolumna event jako TEXT)
        if (json.type === 64) {
          await q(
            'INSERT INTO plugins (session, handle, plugin, event, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [sessionId, handleId, plugin, eventStr, ts]
          );
        } else {
          await q(
            'INSERT INTO transports (session, handle, plugin, event, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [sessionId, handleId, plugin, eventStr, ts]
          );
        }

        // slowlink / slowlink_threshold (jeśli występuje w payloadzie)
        if (hasSlowlink(data)) {
          await saveSlowlink(sessionId, handleId, data, ts);
        }

        // mapowanie SIP (janus.plugin.sip)
        if (plugin === 'janus.plugin.sip' && data) {
          await saveSipCallMap(sessionId, handleId, data, ts);
        }

        break;
      }

      case 256: { // Core
        const ev = json.event || {};

        // slowlink w eventach core (na wszelki wypadek)
        if (hasSlowlink(ev)) {
          await saveSlowlink(json.session_id ?? null, json.handle_id ?? null, ev, ts);
        }

        const name = 'status';
        let value = ev?.[name] ?? null;
        const signum = ev?.signum;
        if (signum) value = `${value} (${signum})`;

        await q(
          'INSERT INTO core (name, value, timestamp) VALUES ($1, $2, $3)',
          [name, value, ts]
        );
        break;
      }

      default:
        console.warn('Unsupported event type', json.type);
    }
  } catch (err) {
    console.error('handleEvent error:', err.message, '\nPayload:', safeStringify(json));
  }
}

/* --------- utils (lokalne) --------- */

// bezpieczne stringify do logów
function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return '[unserializable]'; }
}

module.exports = { handleEvent };
