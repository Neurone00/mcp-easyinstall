-- Moskito Easy MCP usage, one row per counted thing, the same shape the
-- collector has always written (formerly to Analytics Engine, which kept only
-- three months and could not delete). Apply: npx wrangler d1 execute moskito-usage --remote --file usage-schema.sql
CREATE TABLE IF NOT EXISTS rows (
  at INTEGER NOT NULL,          -- ms; for a failure, when it happened on the Mac
  install TEXT NOT NULL,        -- random id per install
  kind TEXT NOT NULL,           -- install | app | client | tool | errtype | errlog
  name TEXT, version TEXT, day TEXT,
  mac TEXT,                     -- the Mac's name (install and errlog rows, 2.55.0+)
  tool TEXT, type TEXT, message TEXT, client TEXT,   -- errlog only
  calls REAL DEFAULT 0, errors REAL DEFAULT 0, bytes REAL DEFAULT 0, script_errors REAL DEFAULT 0,
  source TEXT DEFAULT 'collect' -- 'ae' for rows copied from Analytics Engine
);
CREATE INDEX IF NOT EXISTS rows_kind_at ON rows (kind, at);
CREATE INDEX IF NOT EXISTS rows_install ON rows (install);
