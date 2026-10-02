'use strict';
// 模拟消息适配器：不接入真实 IM/邮件，发送即写入 messages 表（回执）并追加本地 outbox 日志。
// 接口保持 adapter 形态，未来可替换为真实实现。

const fs = require('fs');
const path = require('path');
const { nowIso } = require('./util');

function outboxPath() {
  return process.env.MENTOR_OUTBOX || path.join(__dirname, '..', 'data', 'outbox.log');
}

// send(db, userId, kind, title, body) -> 回执行
function send(db, userId, kind, title, body) {
  const at = nowIso();
  const r = db.prepare(
    'INSERT INTO messages (user_id, kind, title, body, status, created_at) VALUES (?,?,?,?,?,?)'
  ).run(userId, kind, title, body || '', 'delivered', at);
  try {
    fs.mkdirSync(path.dirname(outboxPath()), { recursive: true });
    fs.appendFileSync(
      outboxPath(),
      `[${at}] -> user#${userId} [${kind}] ${title} :: ${String(body || '').replace(/\n/g, ' ')}\n`
    );
  } catch { /* outbox 仅作旁证，失败不影响主流程 */ }
  return { id: Number(r.lastInsertRowid), status: 'delivered', at };
}

function listForUser(db, userId, limit) {
  return db.prepare(
    'SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, limit || 50);
}

function listAll(db, limit) {
  return db.prepare(
    `SELECT m.*, u.name AS user_name FROM messages m JOIN users u ON u.id = m.user_id
     ORDER BY m.id DESC LIMIT ?`
  ).all(limit || 200);
}

module.exports = { send, listForUser, listAll };
