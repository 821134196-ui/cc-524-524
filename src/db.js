'use strict';
// SQLite 数据层：连接、schema、立即事务（容量竞争的正确性依赖 BEGIN IMMEDIATE 串行化）

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.MENTOR_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.MENTOR_DB || path.join(DATA_DIR, 'mentor.db');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('employee','mentor','supervisor','admin')),
  department TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mentor_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  expertise TEXT NOT NULL DEFAULT '[]',      -- JSON 数组：擅长领域
  monthly_capacity INTEGER NOT NULL DEFAULT 1, -- 每月可带人数
  bio TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  left_at TEXT
);

CREATE TABLE IF NOT EXISTS mentor_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mentor_id INTEGER NOT NULL REFERENCES users(id),
  weekday INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES users(id),
  skills TEXT NOT NULL DEFAULT '[]',          -- JSON 数组：希望提升的岗位技能
  slots TEXT NOT NULL DEFAULT '[]',           -- JSON 数组：可交流时段 [{weekday,start,end}]
  note TEXT NOT NULL DEFAULT '',
  preferred_mentor_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','matched','rejected','conflict','cancelled')),
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER REFERENCES applications(id),
  mentor_id INTEGER NOT NULL REFERENCES users(id),
  employee_id INTEGER NOT NULL REFERENCES users(id),
  supervisor_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  end_reason TEXT,                            -- completed / early_completed / changed / mentor_left
  created_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','closing','closed','transferred','suspended')),
  previous_plan_id INTEGER REFERENCES plans(id),
  close_type TEXT,                            -- early / completed
  created_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dropped')),
  target_date TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  goal_id INTEGER REFERENCES goals(id),
  seq INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  held_at TEXT,
  summary TEXT NOT NULL DEFAULT '',           -- 公开纪要
  next_goals TEXT NOT NULL DEFAULT '',        -- 下次目标（公开）
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  session_id INTEGER REFERENCES sessions(id),
  author_id INTEGER NOT NULL REFERENCES users(id),  -- 服务端强制 = 当前登录人，禁止代提交
  body TEXT NOT NULL,                          -- 私人反馈：仅当事双方与授权主管可见
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  employee_id INTEGER NOT NULL REFERENCES users(id),
  old_mentor_id INTEGER NOT NULL REFERENCES users(id),
  preferred_mentor_id INTEGER REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','cancelled')),
  reviewer_id INTEGER REFERENCES users(id),
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS closure_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'completed' CHECK(type IN ('early','completed')), -- 提前完成 / 正常结项
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','cancelled')),
  reviewer_id INTEGER REFERENCES users(id),
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (          -- 模拟消息适配器的回执
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'delivered',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_logs (       -- 访问记录（私密内容查看、审核动作等）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (       -- 附件元数据；文件本体存本地 attachments/
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_flags (    -- 提醒去重
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_matches_mentor ON matches(mentor_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_employee ON matches(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_plan ON sessions(plan_id);
CREATE INDEX IF NOT EXISTS idx_feedback_plan ON feedback(plan_id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_access_user ON access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_plan ON goals(plan_id);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 8000;'); // 并发写时等待而非立即失败
  db.exec(SCHEMA);
  return db;
}

// BEGIN IMMEDIATE：进入事务即取写锁，容量检查+占用名额在同一临界区内完成，
// 两个主管并发确认时由 SQLite 串行化，后到者看到最新计数，不会重复占用名额。
function txImmediate(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

module.exports = { openDb, txImmediate, DB_PATH, DATA_DIR };
