PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS matches (
  game_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  region_route TEXT NOT NULL,
  queue_id INTEGER NOT NULL,
  game_version_raw TEXT NOT NULL,
  patch_public TEXT,
  ddragon_version TEXT,
  start_ts_ms INTEGER NOT NULL,
  duration_s REAL NOT NULL CHECK(duration_s > 0),
  blue_win INTEGER NOT NULL CHECK(blue_win IN (0,1)),
  ingestion_source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  quality_status TEXT NOT NULL DEFAULT 'PENDING'
);

CREATE TABLE IF NOT EXISTS participants (
  game_id TEXT NOT NULL REFERENCES matches(game_id),
  participant_id INTEGER NOT NULL CHECK(participant_id BETWEEN 1 AND 10),
  side TEXT NOT NULL CHECK(side IN ('BLUE','RED')),
  champion_id INTEGER NOT NULL,
  declared_role TEXT,
  inferred_role TEXT,
  role_probability REAL CHECK(role_probability BETWEEN 0 AND 1),
  puuid_hmac TEXT,
  PRIMARY KEY(game_id, participant_id)
);

CREATE TABLE IF NOT EXISTS reported_bans (
  game_id TEXT NOT NULL REFERENCES matches(game_id),
  side TEXT NOT NULL CHECK(side IN ('BLUE','RED')),
  ban_turn_reported INTEGER,
  champion_id INTEGER NOT NULL,
  PRIMARY KEY(game_id, side, ban_turn_reported)
);

CREATE TABLE IF NOT EXISTS source_documents (
  source_id TEXT PRIMARY KEY,
  source_url TEXT,
  source_type TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source_version TEXT,
  field_semantics_verified INTEGER,
  sample_n INTEGER,
  content_sha256 TEXT,
  usage_license_review TEXT
);

CREATE TABLE IF NOT EXISTS champion_trait_labels (
  champion_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  patch_public TEXT NOT NULL,
  dimension TEXT NOT NULL,
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 1),
  label_confidence REAL NOT NULL CHECK(label_confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK(status IN ('PROVISIONAL','REVIEWED','REJECTED')),
  evidence_url TEXT,
  reviewer TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(champion_id, role, patch_public, dimension)
);

CREATE TABLE IF NOT EXISTS rank_snapshots (
  puuid_hmac TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  queue_type TEXT NOT NULL,
  tier TEXT,
  division TEXT,
  league_points INTEGER,
  source TEXT,
  PRIMARY KEY(puuid_hmac, observed_at, queue_type)
);

CREATE INDEX IF NOT EXISTS ix_matches_cohort ON matches(queue_id, patch_public, start_ts_ms);
CREATE INDEX IF NOT EXISTS ix_participants_champion_role ON participants(champion_id, inferred_role);
