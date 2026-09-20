'use strict';

/**
 * SQLite 持久化层（better-sqlite3，同步 API）
 * 剧目以整文档 JSON 的方式读写；启动时自动建表并在空库中写入示例剧目。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { validateDocument } = require('./analyzer');
const seed = require('./seed');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
  CREATE TABLE IF NOT EXISTS plays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    doc        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);

  const count = db.prepare('SELECT COUNT(*) AS c FROM plays').get().c;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO plays (name, doc) VALUES (?, ?)');
    for (const doc of seed.seedPlays) {
      insert.run(doc.name, JSON.stringify(doc));
    }
    console.log(`[db] 已初始化 ${seed.seedPlays.length} 个示例剧目`);
  }
  return db;
}

function listPlays() {
  return db
    .prepare("SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM plays ORDER BY updated_at DESC, id DESC")
    .all();
}

function getPlay(id) {
  const row = db.prepare('SELECT * FROM plays WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doc: JSON.parse(row.doc),
  };
}

function createPlay(doc) {
  const { errors } = validateDocument(doc);
  if (errors.length) {
    const err = new Error(`文档校验失败：${errors.join('；')}`);
    err.status = 400;
    throw err;
  }
  const info = db
    .prepare("INSERT INTO plays (name, doc) VALUES (?, ?)")
    .run(doc.name, JSON.stringify(doc));
  return getPlay(info.lastInsertRowid);
}

function updatePlay(id, doc) {
  const exists = db.prepare('SELECT id FROM plays WHERE id = ?').get(id);
  if (!exists) return null;
  const { errors } = validateDocument(doc);
  if (errors.length) {
    const err = new Error(`文档校验失败：${errors.join('；')}`);
    err.status = 400;
    throw err;
  }
  db.prepare("UPDATE plays SET name = ?, doc = ?, updated_at = datetime('now') WHERE id = ?").run(
    doc.name,
    JSON.stringify(doc),
    id,
  );
  return getPlay(id);
}

function deletePlay(id) {
  const info = db.prepare('DELETE FROM plays WHERE id = ?').run(id);
  return info.changes > 0;
}

module.exports = { init, listPlays, getPlay, createPlay, updatePlay, deletePlay };
