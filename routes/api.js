// routes/api.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

function parseBucket(bucket) {
  const map = { '1m': 60, '5m': 300, '15m': 900 };
  return map[String(bucket || '1m')] || 60;
}

router.get('/health', (req, res) => res.json({ ok: true }));

// GET /api/sessions -> [{ session }]
router.get('/sessions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT session FROM handles
       WHERE session IS NOT NULL
       ORDER BY session DESC
       LIMIT 1000`
    );
    res.json(rows);
  } catch (e) {
    console.error('sessions error', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /api/handles?session=123 -> [{ handle }]
router.get('/handles', async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT handle FROM handles
       WHERE session = $1 AND handle IS NOT NULL
       ORDER BY handle DESC
       LIMIT 1000`, [session]
    );
    res.json(rows);
  } catch (e) {
    console.error('handles error', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /api/stats/series?session=...&handle=...&from=ISO&to=ISO&bucket=1m
router.get('/stats/series', async (req, res) => {
  const { session, handle, from, to, bucket = '1m' } = req.query;
  if (!session || !handle || !from || !to) {
    return res.status(400).json({ error: 'Missing session/handle/from/to' });
  }
  const stepSec = parseBucket(bucket);
  try {
    const { rows } = await pool.query(
      `WITH binned AS (
         SELECT
           to_timestamp(floor(extract(epoch from timestamp)/$3)*$3) AS ts,
           AVG(jitterlocal) AS jitterlocal,
           AVG(jitterremote) AS jitterremote,
           SUM(lostlocal) AS lostlocal,
           SUM(lostremote) AS lostremote,
           SUM(bytessent) AS sum_bytes_sent,
           SUM(bytesrecv) AS sum_bytes_recv
         FROM stats
         WHERE session = $1 AND handle = $2
           AND timestamp >= $4::timestamptz AND timestamp <= $5::timestamptz
         GROUP BY 1
       )
       SELECT ts, jitterlocal, jitterremote, lostlocal, lostremote,
              (sum_bytes_sent * 8.0) / $3 AS tx_bps,
              (sum_bytes_recv * 8.0) / $3 AS rx_bps
       FROM binned
       ORDER BY ts ASC`,
      [session, handle, stepSec, from, to]
    );
    res.json(rows);
  } catch (e) {
    console.error('stats/series error', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /api/events/recent?session=...&handle=...&limit=50
router.get('/events/recent', async (req, res) => {
  const { session, handle } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  if (!session || !handle) return res.status(400).json({ error: 'Missing session/handle' });
  try {
    const { rows } = await pool.query(
      `SELECT timestamp AS time, 'ICE' AS type, state, NULL::text AS detail
         FROM ice WHERE session=$1 AND handle=$2
       UNION ALL
       SELECT timestamp, 'DTLS', state, NULL
         FROM dtls WHERE session=$1 AND handle=$2
       UNION ALL
       SELECT timestamp, 'JSEP', CASE WHEN offer THEN 'offer' ELSE 'answer' END,
              LEFT(sdp, 160)
         FROM sdps WHERE session=$1 AND handle=$2
       ORDER BY time DESC
       LIMIT $3::int`,
      [session, handle, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error('events/recent error', e);
    res.status(500).json({ error: 'db_error' });
  }
});

module.exports = router;
