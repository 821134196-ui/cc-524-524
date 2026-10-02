'use strict';
// 进程内提醒任务：定期扫描
//  1) 辅导长期未开始（配对确认超过 UNSTARTED_DAYS 天仍无任何辅导次）→ 提醒双方，再超期则升级通知主管
//  2) 24 小时内即将开始的辅导次 → 提醒双方
// 用 reminder_flags 去重，重启进程不会重复轰炸。

const messaging = require('./messaging');
const { nowIso } = require('./util');

const UNSTARTED_DAYS = Number(process.env.MENTOR_UNSTARTED_DAYS || 14);
const ESCALATE_DAYS = Number(process.env.MENTOR_ESCALATE_DAYS || 21);

function daysBetween(isoA, isoB) {
  return (new Date(isoB.replace('T', ' ')) - new Date(isoA.replace('T', ' '))) / 86400000;
}

function flag(db, planId, kind) {
  try {
    db.prepare('INSERT INTO reminder_flags (plan_id, kind, created_at) VALUES (?,?,?)')
      .run(planId, kind, nowIso());
    return true;
  } catch {
    return false; // UNIQUE 冲突 = 已提醒过
  }
}

function scan(db, now) {
  const nowStr = now || nowIso();
  const result = { unstarted: 0, escalated: 0, upcoming: 0 };

  // 长期未开始
  const rows = db.prepare(
    `SELECT p.id AS plan_id, m.confirmed_at, m.mentor_id, m.employee_id,
            mu.name AS mentor_name, eu.name AS employee_name
     FROM plans p
     JOIN matches m ON m.id = p.match_id
     JOIN users mu ON mu.id = m.mentor_id
     JOIN users eu ON eu.id = m.employee_id
     WHERE m.status = 'active' AND p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.plan_id = p.id)`
  ).all();

  for (const r of rows) {
    const age = daysBetween(r.confirmed_at, nowStr);
    if (age >= ESCALATE_DAYS) {
      if (flag(db, r.plan_id, 'unstarted_escalated')) {
        const sups = db.prepare(
          "SELECT id FROM users WHERE role IN ('supervisor','admin') AND active = 1"
        ).all();
        for (const s of sups) {
          messaging.send(db, s.id, 'unstarted_escalated', '辅导长期未开始（升级）',
            `计划 #${r.plan_id}（${r.employee_name} × ${r.mentor_name}）确认已超过 ${ESCALATE_DAYS} 天仍未开始辅导，请介入协调。`);
        }
        result.escalated += 1;
      }
    } else if (age >= UNSTARTED_DAYS) {
      if (flag(db, r.plan_id, 'unstarted')) {
        messaging.send(db, r.employee_id, 'unstarted', '辅导尚未开始提醒',
          `您与导师 ${r.mentor_name} 的计划 #${r.plan_id} 确认已超过 ${UNSTARTED_DAYS} 天，请尽快预约第一次辅导。`);
        messaging.send(db, r.mentor_id, 'unstarted', '辅导尚未开始提醒',
          `您与员工 ${r.employee_name} 的计划 #${r.plan_id} 确认已超过 ${UNSTARTED_DAYS} 天，请尽快安排第一次辅导。`);
        result.unstarted += 1;
      }
    }
  }

  // 24 小时内即将开始的辅导次
  const soon = db.prepare(
    `SELECT s.id, s.plan_id, s.scheduled_at, m.mentor_id, m.employee_id
     FROM sessions s
     JOIN plans p ON p.id = s.plan_id
     JOIN matches m ON m.id = p.match_id
     WHERE s.held_at IS NULL AND m.status = 'active' AND p.status = 'active'`
  ).all();
  for (const s of soon) {
    const hours = (new Date(s.scheduled_at.replace('T', ' ')) - new Date(nowStr.replace('T', ' '))) / 3600000;
    if (hours > 0 && hours <= 24 && flag(db, s.plan_id, `session_reminder_${s.id}`)) {
      messaging.send(db, s.mentor_id, 'session_upcoming', '辅导即将开始',
        `计划 #${s.plan_id} 第 ${s.id} 次辅导将于 ${s.scheduled_at.replace('T', ' ')} 开始。`);
      messaging.send(db, s.employee_id, 'session_upcoming', '辅导即将开始',
        `计划 #${s.plan_id} 第 ${s.id} 次辅导将于 ${s.scheduled_at.replace('T', ' ')} 开始。`);
      result.upcoming += 1;
    }
  }
  return result;
}

// 启动进程内定时任务，返回停止函数
function startScheduler(db, intervalMs) {
  const timer = setInterval(() => {
    try { scan(db); } catch (e) { console.error('[reminder] scan failed:', e.message); }
  }, intervalMs || 60000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { scan, startScheduler, UNSTARTED_DAYS, ESCALATE_DAYS };
