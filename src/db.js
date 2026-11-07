'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS players (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      name_key    TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS matches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      player_a    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      player_b    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      score_a     INTEGER,
      score_b     INTEGER,
      result      TEXT NOT NULL CHECK (result IN ('A','B','D')),
      played_at   INTEGER NOT NULL,
      CHECK (player_a <> player_b)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_played ON matches(played_at);

    CREATE TABLE IF NOT EXISTS adjustments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      amount      INTEGER NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );

    -- Bütün yönetici işlemlerinin silinmeyen kaydı
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      details     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Yönetici oturumları: yalnızca token'ın SHA-256 özeti saklanır
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash  TEXT PRIMARY KEY,
      expires_at  INTEGER NOT NULL
    );
  `);
  return db;
}

/** Bir fonksiyonu tek bir SQLite işlemi (transaction) içinde çalıştırır. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx };
