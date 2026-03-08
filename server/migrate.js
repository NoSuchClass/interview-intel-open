#!/usr/bin/env node
/**
 * migrate.js - 轻量级 SQLite 迁移工具
 *
 * 用法：node migrate.js [--db <path>]
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// DB 路径：优先用命令行参数，否则用默认路径
const args = process.argv.slice(2);
const dbArgIdx = args.indexOf('--db');
const DB_PATH = dbArgIdx !== -1
  ? path.resolve(args[dbArgIdx + 1])
  : path.join(__dirname, '../skill/data/interview-intel.db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function backupDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${DB_PATH}.backup-${ts}`;
  fs.copyFileSync(DB_PATH, backupPath);
  // 同时备份 WAL 文件（如果存在）
  const walPath = DB_PATH + '-wal';
  if (fs.existsSync(walPath)) {
    fs.copyFileSync(walPath, backupPath + '-wal');
  }
  console.log(`   💾 已备份到: ${backupPath}`);
  return backupPath;
}

function run() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    // fallback: 从 skill/scripts/node_modules 加载
    const fallbackPath = path.join(__dirname, '../skill/scripts/node_modules/better-sqlite3');
    Database = require(fallbackPath);
  }

  const backupPath = backupDb();

  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map(r => r.filename)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ⏭  ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  ▶  applying ${file}...`);

    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    });

    try {
      applyMigration();
      console.log(`  ✅ ${file} applied`);
      count++;
    } catch (err) {
      console.error(`  ❌ ${file} failed: ${err.message}`);
      if (backupPath) {
        console.error(`\n  🔄 恢复命令: cp "${backupPath}" "${DB_PATH}"`);
      }
      process.exit(1);
    }
  }

  if (count === 0) {
    console.log('  ✅ DB is up to date, no migrations needed');
  } else {
    console.log(`\n  ✅ Applied ${count} migration(s)`);
  }

  db.close();
}

console.log('\n🗄  Running DB migrations...');
console.log(`   DB: ${DB_PATH}`);
console.log(`   Migrations dir: ${MIGRATIONS_DIR}\n`);
run();
