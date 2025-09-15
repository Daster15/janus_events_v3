
const { pool } = require('./db');
const { toDate } = require('./utils');

async function handleEvent(payload) {
  if (Array.isArray(payload)) {
    for (const item of payload) await handleEvent(item);
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  const json = payload;
  const ts = toDate(json.timestamp);
  const q = (text, values) => pool.query(text, values);

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
    case 16: { // WebRTC events
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
        console.error('Unsupported WebRTC event?');
      }
      break;
    }
    case 32: { // Media/Stats
      const sessionId = json.session_id ?? null;
      const handleId = json.handle_id ?? null;
      const medium = json.event?.media ?? null;

      if (json.event?.receiving !== undefined && json.event?.receiving !== null) {
        const receiving = json.event.receiving === true;
        await q(
          'INSERT INTO media (session, handle, medium, receiving, timestamp) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, handleId, medium, receiving, ts]
        );
      } else if (json.event?.base !== undefined && json.event?.base !== null) {
        const e = json.event;
        await q(
          `INSERT INTO stats
           (session, handle, medium, base, lsr, lostlocal, lostremote, jitterlocal, jitterremote,
            packetssent, packetsrecv, bytessent, bytesrecv, nackssent, nacksrecv, timestamp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            sessionId, handleId, medium,
            e.base ?? null, e.lsr ?? null,
            e.lost ?? null, e['lost-by-remote'] ?? null,
            e['jitter-local'] ?? null, e['jitter-remote'] ?? null,
            e['packets-sent'] ?? null, e['packets-received'] ?? null,
            e['bytes-sent'] ?? null, e['bytes-received'] ?? null,
            e['nacks-sent'] ?? null, e['nacks-received'] ?? null,
            ts
          ]
        );
      } else {
        console.error('Unsupported media event?');
      }
      break;
    }
    case 64:
    case 128: { // Plugin / Transport
      const sessionId = json.session_id ?? null;
      const handleId = json.handle_id ?? null;
      const plugin = json.event?.plugin ?? null;
      const event = JSON.stringify(json.event?.data ?? null);
      const table = json.type === 64 ? 'plugins' : 'transports';
      await q(
        `INSERT INTO ${table} (session, handle, plugin, event, timestamp) VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, handleId, plugin, event, ts]
      );
      break;
    }
    case 256: { // Core
      const name = 'status';
      let value = json.event?.[name] ?? null;
      const signum = json.event?.signum;
      if (signum) value = `${value} (${signum})`;
      await q('INSERT INTO core (name, value, timestamp) VALUES ($1, $2, $3)', [name, value, ts]);
      break;
    }
    default:
      console.warn('Unsupported event type', json.type);
  }
}

module.exports = { handleEvent };
