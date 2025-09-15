-- migrations/2025-09-09_add_slowlinks_and_indexes.sql

-- Tabela dla slowlink / slowlink_threshold (jeśli nie istnieje)
CREATE TABLE IF NOT EXISTS slowlinks (
  id BIGSERIAL PRIMARY KEY,
  session BIGINT,
  handle BIGINT,
  payload JSONB,
  timestamp TIMESTAMPTZ NOT NULL
);

-- Indeksy przyspieszające REST API
CREATE INDEX IF NOT EXISTS idx_handles_session_handle ON handles(session, handle);
CREATE INDEX IF NOT EXISTS idx_stats_sh_ts ON stats(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_ice_sh_ts   ON ice(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_dtls_sh_ts  ON dtls(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_sdps_sh_ts  ON sdps(session, handle, timestamp);
CREATE INDEX IF NOT EXISTS idx_slowlinks_sh_ts ON slowlinks(session, handle, timestamp);
