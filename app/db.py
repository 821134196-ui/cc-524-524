"""SQLite 连接与建表。

并发策略: 单文件 SQLite, 开启 WAL; 所有"占用名额/时段"的关键写操作
在 IMMEDIATE 事务内完成 (SELECT 剩余名额 -> INSERT)。两个主管同时配对
同一导师时, 第二个事务在 BEGIN IMMEDIATE 处阻塞/报 SQLITE_BUSY,
由 service 层重试, 保证不超额。
"""
from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

DB_PATH = Path(os.environ.get("MENTOR_DB_PATH",
                             Path(__file__).resolve().parent.parent / "data" / "mentor.db"))
_ATTACH_DIR = Path(os.environ.get("MENTOR_ATTACH_DIR",
                                 Path(__file__).resolve().parent.parent / "data" / "attachments"))

_init_lock = threading.Lock()
_initialized = False

SCHEMA = """
PRAGMA foreign_keys = ON;

-- 用户: role = employee / mentor / manager (导师本身也是员工, 可被别人带)
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    department    TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('employee','mentor','manager')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    left_at       TEXT
);

-- 导师档案 (mentor 1:1 users)
CREATE TABLE IF NOT EXISTS mentors (
    id             INTEGER PRIMARY KEY REFERENCES users(id),
    expertise      TEXT NOT NULL,          -- 擅长领域, 逗号分隔
    monthly_cap    INTEGER NOT NULL,       -- 每月可带人数
    dept           TEXT NOT NULL,
    accepts_cross  INTEGER NOT NULL DEFAULT 0  -- 是否接受跨部门
);

-- 员工的匹配申请
CREATE TABLE IF NOT EXISTS match_requests (
    id           INTEGER PRIMARY KEY,
    employee_id  INTEGER NOT NULL REFERENCES users(id),
    skill        TEXT NOT NULL,            -- 希望提升的岗位技能
    slots        TEXT NOT NULL,            -- 可交流时段 JSON [{"weekday":1,"period":"19:00-20:00"}]
    note         TEXT DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','MATCHED','CANCELLED','TRANSFERRING')),
    created_at   TEXT NOT NULL
);

-- 辅导计划
CREATE TABLE IF NOT EXISTS plans (
    id              INTEGER PRIMARY KEY,
    request_id      INTEGER NOT NULL REFERENCES match_requests(id),
    employee_id     INTEGER NOT NULL REFERENCES users(id),
    mentor_id       INTEGER NOT NULL REFERENCES users(id),
    cross_dept      INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','ABANDONED')),
    predecessor_plan_id INTEGER REFERENCES plans(id),  -- 换导师后新计划指向旧计划
    created_at      TEXT NOT NULL,
    accepted_at     TEXT,
    completed_at    TEXT
);

-- 已排时段 (用于时间冲突检测); 结项/废弃的历史时段不再占用
CREATE TABLE IF NOT EXISTS schedule_slots (
    id          INTEGER PRIMARY KEY,
    plan_id     INTEGER NOT NULL REFERENCES plans(id),
    mentor_id   INTEGER NOT NULL REFERENCES users(id),
    employee_id INTEGER NOT NULL REFERENCES users(id),
    weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    period      TEXT NOT NULL,            -- "19:00-20:00"
    active      INTEGER NOT NULL DEFAULT 1
);

-- 辅导纪要条目: kind = goal(公开目标) / feedback_private(私密反馈) / session(公开进展)
CREATE TABLE IF NOT EXISTS journal_entries (
    id          INTEGER PRIMARY KEY,
    plan_id     INTEGER NOT NULL REFERENCES plans(id),
    kind        TEXT NOT NULL CHECK (kind IN ('goal','session','feedback_private')),
    author_id   INTEGER NOT NULL REFERENCES users(id),
    author_role TEXT NOT NULL,            -- employee / mentor
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    target_date TEXT,                     -- 目标时间线日期
    created_at  TEXT NOT NULL
);

-- 换导师申请
CREATE TABLE IF NOT EXISTS transfer_requests (
    id           INTEGER PRIMARY KEY,
    plan_id      INTEGER NOT NULL REFERENCES plans(id),
    employee_id  INTEGER NOT NULL REFERENCES users(id),
    reason       TEXT NOT NULL,
    new_mentor_id INTEGER REFERENCES users(id),  -- 可指定意向导师
    status       TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
    created_at   TEXT NOT NULL,
    decided_at   TEXT,
    decided_by   INTEGER REFERENCES users(id)
);

-- 结项申请(提前完成): 计划完成前由任一方发起, 主管审核
CREATE TABLE IF NOT EXISTS completion_requests (
    id          INTEGER PRIMARY KEY,
    plan_id     INTEGER NOT NULL REFERENCES plans(id),
    requester_id INTEGER NOT NULL REFERENCES users(id),
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    created_at  TEXT NOT NULL,
    decided_at  TEXT,
    decided_by  INTEGER REFERENCES users(id)
);

-- 模拟消息回执
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    receiver_id INTEGER NOT NULL REFERENCES users(id),
    mtype       TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'SENT',  -- SENT / READ
    created_at  TEXT NOT NULL
);

-- 计划附件(本地虚构文件, 仅当事双方与授权主管可下载)
CREATE TABLE IF NOT EXISTS plan_attachments (
    id          INTEGER PRIMARY KEY,
    plan_id     INTEGER NOT NULL REFERENCES plans(id),
    filename    TEXT NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL
);

-- 敏感访问审计: 私密反馈的每次查看 / 越权拒绝
CREATE TABLE IF NOT EXISTS access_log (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER,
    action     TEXT NOT NULL,
    plan_id    INTEGER,
    allowed    INTEGER NOT NULL,
    detail     TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _ATTACH_DIR.mkdir(parents=True, exist_ok=True)
        conn = get_conn()
        try:
            conn.executescript(SCHEMA)
        finally:
            conn.close()
        _initialized = True


def attachment_dir() -> Path:
    _ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    return _ATTACH_DIR
