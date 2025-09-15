
const auth = require('basic-auth');
const config = require('./settings');

function requireBasicAuth(req, res) {
  const a = config.http?.auth;
  if (!a || !a.username || !a.password) return true; // no auth required
  const credentials = auth(req);
  if (!credentials || credentials.name !== a.username || credentials.pass !== a.password) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="Janus events DB backend"');
    res.end();
    return false;
  }
  return true;
}

module.exports = { requireBasicAuth };
