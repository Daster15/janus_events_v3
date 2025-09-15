
module.exports = {
  db: {
    // Alternatively: connectionString: 'postgres://janus:secret@localhost:5432/janus'
    host: 'localhost',
    port: 5432,
    user: 'arek',
    password: 'arek',
    database: 'janus',
    max: 10,
    idleTimeoutMillis: 30000
  },
  http: {
    host: '192.168.221.19',
    port: 8085,
    // remove `auth` to disable Basic Auth
    auth: { username: 'admin', password: 'adminpass' }
  },
  limits: {
    bodyBytes: 256 * 1024 // 256 KB
  }
};
