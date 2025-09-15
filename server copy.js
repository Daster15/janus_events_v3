// server.js (Express REST + webhook)
const express = require('express');
const cors = require('cors');
const config = require('./settings');
const { requireBasicAuth } = require('./auth');
const { handleEvent } = require('./eventHandler');
const { ensureConnected, shutdown } = require('./db');

const app = express();

// Body parser (limit wg settings.limits.bodyBytes lub 1mb)
const bodyLimit = (config.limits && config.limits.bodyBytes) ? config.limits.bodyBytes : '1mb';
app.use(express.json({ limit: bodyLimit }));
app.use(cors());

// Health
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Webhook Janusa (opcjonalny BasicAuth w requireBasicAuth)
app.post('/hooks/janus', requireBasicAuth, async (req, res) => {
  try {
    await handleEvent(req.body);
    res.status(200).end();
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ error: 'hook_failed' });
  }
});

// REST API
app.use('/api', require('./routes/api'));

// Start
(async () => {
  try {
    await ensureConnected?.();
  } catch (e) {
    console.error('DB connect failed:', e);
    process.exit(1);
  }
  const host = (config.http && config.http.host) || '0.0.0.0';
  const port = (config.http && config.http.port) || 8085;
  app.listen(port, host, () => {
    console.log(`HTTP up: http://${host}:${port}  (hooks: /hooks/janus, api: /api/...)`);
  });
})();

// Graceful shutdown
async function graceful(sig) {
  console.log(`Signal ${sig} received, shutting down...`);
  try {
    await shutdown?.();
  } catch(e) {
    console.error('Shutdown error:', e);
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => graceful('SIGINT'));
process.on('SIGTERM', () => graceful('SIGTERM'));
