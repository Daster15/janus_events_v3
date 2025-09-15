
-- PostgreSQL schema for Janus events backend
-- Adjust types/comment as needed. Uses timestamptz for correct UTC handling.

CREATE TABLE IF NOT EXISTS sessions (
  id bigserial PRIMARY KEY,
  session bigint,
  event text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS handles (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  event text,
  plugin text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS sdps (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  remote boolean,
  offer boolean,
  sdp text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS ice (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  stream bigint,
  component bigint,
  state text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS selectedpairs (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  stream bigint,
  component bigint,
  selected text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS dtls (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  state text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS connections (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  state text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS media (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  medium text,
  receiving boolean,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS stats (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  medium text,
  base bigint,
  lsr bigint,
  lostlocal bigint,
  lostremote bigint,
  jitterlocal double precision,
  jitterremote double precision,
  packetssent bigint,
  packetsrecv bigint,
  bytessent bigint,
  bytesrecv bigint,
  nackssent bigint,
  nacksrecv bigint,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS plugins (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  plugin text,
  event jsonb,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS transports (
  id bigserial PRIMARY KEY,
  session bigint,
  handle bigint,
  plugin text,
  event jsonb,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS core (
  id bigserial PRIMARY KEY,
  name text,
  value text,
  timestamp timestamptz
);

CREATE TABLE IF NOT EXISTS sip_calls (
  id BIGSERIAL PRIMARY KEY,
  session BIGINT,
  handle  BIGINT,
  call_id TEXT UNIQUE,            -- klucz korelacji
  from_uri TEXT,
  to_uri   TEXT,
  direction TEXT,                 -- 'in' / 'out'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fs_call_map (
  uuid UUID PRIMARY KEY,
  call_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slowlinks (
  id BIGSERIAL PRIMARY KEY,
  session BIGINT,
  handle BIGINT,
  payload JSONB,
  timestamp TIMESTAMPTZ NOT NULL
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_sessions_session_ts      ON sessions(session, timestamp);
CREATE INDEX IF NOT EXISTS idx_handles_session_handle_ts ON handles(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_sdps_session_handle_ts    ON sdps(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_stats_session_handle_med_ts ON stats(session, handle, medium, timestamp);
CREATE INDEX IF NOT EXISTS idx_media_session_handle_ts   ON media(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_plugins_session_handle_ts ON plugins(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_transports_session_handle_ts ON transports(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_sip_calls_sh ON sip_calls(session, handle);
CREATE INDEX IF NOT EXISTS idx_fs_call_map_call_id ON fs_call_map(call_id);
CREATE INDEX IF NOT EXISTS idx_slowlinks_sh_ts ON slowlinks(session, handle, timestamp);
