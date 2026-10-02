'use strict';
// 领域服务：全部业务规则与状态流转。
// 所有函数第一个参数为 db（node:sqlite 连接），便于在测试/工作线程中使用独立连接。

const { txImmediate } = require('./db');
const {
  nowIso, jparse, anyOverlap, addMinutesIso, slotLabel,
} = require('./util');
const messaging = require('./messaging');

class BizError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const err = (code, msg) => new BizError(code, msg);

// ---------- 基础查询 ----------

function getUser(db, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw err('NOT_FOUND', '用户不存在');
  return u;
}

function getMentorProfile(db, mentorId) {
  const p = db.prepare('SELECT * FROM mentor_profiles WHERE user_id = ?').get(mentorId);
  if (!p) throw err('NOT_FOUND', '导师档案不存在');
  return p;
}

function activeMatchCount(db, mentorId) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM matches WHERE mentor_id = ? AND status = 'active'"
  ).get(mentorId).c;
}

function remainingCapacity(db, mentorId) {
  const p = getMentorProfile(db, mentorId);
  return Math.max(0, p.monthly_capacity - activeMatchCount(db, mentorId));
}

function mentorSlots(db, mentorId) {
  return db.prepare('SELECT * FROM mentor_slots WHERE mentor_id = ? ORDER BY weekday, start_min').all(mentorId);
}

function listMentors(db) {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.department, u.active AS user_active,
            p.expertise, p.monthly_capacity, p.bio, p.active AS mentor_active
     FROM mentor_profiles p JOIN users u ON u.id = p.user_id
     ORDER BY p.active DESC, u.id`
  ).all();
  return rows.map((r) => ({
    ...r,
    expertise: jparse(r.expertise, []),
    slots: mentorSlots(db, r.id),
    active_count: activeMatchCount(db, r.id),
    remaining: Math.max(0, r.monthly_capacity - activeMatchCount(db, r.id)),
  }));
}

function getApplication(db, id) {
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!a) throw err('NOT_FOUND', '申请不存在');
  return a;
}

function getMatch(db, id) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  if (!m) throw err('NOT_FOUND', '配对不存在');
  return m;
}

function getPlan(db, id) {
  const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!p) throw err('NOT_FOUND', '辅导计划不存在');
  return p;
}

// 计划上下文：计划 + 配对 + 双方 + 确认主管
function planContext(db, planId) {
  const ctx = db.prepare(
    `SELECT p.id AS plan_id, p.status AS plan_status, p.title, p.previous_plan_id,
            p.close_type, p.created_at AS plan_created_at, p.started_at, p.closed_at,
            m.id AS match_id, m.status AS match_status, m.mentor_id, m.employee_id, m.supervisor_id,
            mu.name AS mentor_name, mu.department AS mentor_department,
            eu.name AS employee_name, eu.department AS employee_department,
            su.name AS supervisor_name
     FROM plans p
     JOIN matches m ON m.id = p.match_id
     JOIN users mu ON mu.id = m.mentor_id
     JOIN users eu ON eu.id = m.employee_id
     JOIN users su ON su.id = m.supervisor_id
     WHERE p.id = ?`
  ).get(planId);
  if (!ctx) throw err('NOT_FOUND', '辅导计划不存在');
  return ctx;
}

function listGoals(db, planId) {
  return db.prepare('SELECT * FROM goals WHERE plan_id = ? ORDER BY seq, id').all(planId);
}

function listSessions(db, planId) {
  return db.prepare('SELECT * FROM sessions WHERE plan_id = ? ORDER BY scheduled_at, id').all(planId);
}

function listAttachments(db, planId) {
  return db.prepare(
    `SELECT a.*, u.name AS uploader_name FROM attachments a
     JOIN users u ON u.id = a.uploaded_by WHERE a.plan_id = ? ORDER BY a.id`
  ).all(planId);
}

// ---------- 权限 ----------

function isSupervisorLike(user) {
  return user.role === 'supervisor' || user.role === 'admin';
}

function isParty(user, ctx) {
  return user.id === ctx.mentor_id || user.id === ctx.employee_id;
}

function canViewPlan(user, ctx) {
  return isSupervisorLike(user) || isParty(user, ctx);
}

function assertCanViewPlan(user, ctx) {
  if (!canViewPlan(user, ctx)) throw err('FORBIDDEN', '无权查看该辅导计划');
}

// 私人反馈：仅当事双方 + 授权主管（主管/管理员）可见
function canViewFeedback(user, ctx) {
  return isSupervisorLike(user) || isParty(user, ctx);
}

// 跨部门回避：主管与员工或导师同部门时必须回避，由其他部门主管或管理员处理
function recusalReason(user, departments) {
  if (user.role === 'admin') return null;
  if (user.role !== 'supervisor') return '需要主管或管理员权限';
  const hit = departments.filter(Boolean).find((d) => d === user.department);
  if (hit) return `您与相关方同属「${hit}」，按回避制度需转交其他部门主管或管理员处理`;
  return null;
}

function assertNotRecused(user, departments) {
  const reason = recusalReason(user, departments);
  if (reason) throw err('RECUSAL', reason);
}

function logAccess(db, userId, action, objectType, objectId, detail) {
  db.prepare(
    'INSERT INTO access_logs (user_id, action, object_type, object_id, detail, created_at) VALUES (?,?,?,?,?,?)'
  ).run(userId, action, objectType || '', objectId || null, detail || '', nowIso());
}

// 查看私人反馈：鉴权 + 访问留痕
function viewFeedback(db, user, planId) {
  const ctx = planContext(db, planId);
  if (!canViewFeedback(user, ctx)) {
    throw err('FORBIDDEN', '私人反馈仅当事双方与授权主管可见');
  }
  logAccess(db, user.id, 'view_private_feedback', 'plan', planId,
    `${user.name} 查看了计划#${planId} 的私人反馈`);
  return db.prepare(
    `SELECT f.*, u.name AS author_name, u.role AS author_role
     FROM feedback f JOIN users u ON u.id = f.author_id
     WHERE f.plan_id = ? ORDER BY f.id`
  ).all(planId);
}

// ---------- 匹配申请 ----------

function createApplication(db, user, { skills, slots, note, preferredMentorId }) {
  if (user.role !== 'employee') throw err('FORBIDDEN', '仅员工可提交导师申请');
  if (!user.active) throw err('FORBIDDEN', '账号已停用');
  if (!skills || !skills.length) throw err('VALIDATION', '请选择希望提升的岗位技能');
  if (!slots || !slots.length) throw err('VALIDATION', '请选择可交流时段');
  const dup = db.prepare(
    "SELECT id FROM applications WHERE employee_id = ? AND status = 'pending'"
  ).get(user.id);
  if (dup) throw err('VALIDATION', '您已有待处理的申请，请先取消或等待处理');
  const active = db.prepare(
    "SELECT id FROM matches WHERE employee_id = ? AND status = 'active'"
  ).get(user.id);
  if (active) throw err('VALIDATION', '您已有进行中的辅导计划');
  if (preferredMentorId) {
    const m = getUser(db, preferredMentorId);
    if (m.role !== 'mentor') throw err('VALIDATION', '期望导师无效');
    const p = getMentorProfile(db, preferredMentorId);
    if (!p.active) throw err('VALIDATION', '该导师已不可申请');
  }
  const at = nowIso();
  const r = db.prepare(
    `INSERT INTO applications (employee_id, skills, slots, note, preferred_mentor_id, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'pending',?,?)`
  ).run(user.id, JSON.stringify(skills), JSON.stringify(slots), note || '',
    preferredMentorId || null, at, at);
  logAccess(db, user.id, 'create_application', 'application', Number(r.lastInsertRowid), '');
  return { id: Number(r.lastInsertRowid) };
}

function cancelApplication(db, user, appId) {
  const a = getApplication(db, appId);
  if (a.employee_id !== user.id && user.role !== 'admin') throw err('FORBIDDEN', '仅本人可取消申请');
  if (a.status !== 'pending') throw err('STATUS', '该申请已处理，无法取消');
  db.prepare("UPDATE applications SET status='cancelled', updated_at=? WHERE id=?").run(nowIso(), appId);
}

// 主管确认配对：回避检查 → 时段冲突检查 → 立即事务内检查容量并占用名额
function confirmApplication(db, user, appId, mentorId) {
  const a = getApplication(db, appId);
  if (a.status !== 'pending') throw err('STATUS', '该申请不在待确认状态');
  const employee = getUser(db, a.employee_id);
  const mentor = getUser(db, mentorId);
  if (mentor.role !== 'mentor') throw err('VALIDATION', '所选对象不是导师');
  const profile = getMentorProfile(db, mentorId);
  if (!profile.active || !mentor.active) throw err('VALIDATION', '该导师已离职或停用');

  // 跨部门回避
  assertNotRecused(user, [employee.department, mentor.department]);

  // 时间冲突：员工可交流时段与导师可带时段需有交集
  const want = jparse(a.slots, []);
  const have = mentorSlots(db, mentorId);
  if (!anyOverlap(want, have)) {
    db.prepare("UPDATE applications SET status='conflict', review_note=?, updated_at=? WHERE id=?")
      .run('员工可交流时段与导师可带时段无交集，请员工调整时段或改选导师', nowIso(), appId);
    messaging.send(db, employee.id, 'conflict',
      '匹配申请时段冲突',
      `您申请的导师 ${mentor.name} 的可带时段与您的可交流时段无交集，请调整时段后重新提交。`);
    throw err('CONFLICT', '时段冲突：员工可交流时段与导师可带时段无交集，申请已标记为冲突并通知员工');
  }

  return txImmediate(db, () => {
    // 容量临界区：同一时间段导师容量不可超；并发确认由 BEGIN IMMEDIATE 串行化
    const count = activeMatchCount(db, mentorId);
    if (count >= profile.monthly_capacity) {
      throw err('CAPACITY_FULL',
        `导师 ${mentor.name} 本月名额已满（${count}/${profile.monthly_capacity}），请选择其他导师`);
    }
    const busy = db.prepare(
      "SELECT id FROM matches WHERE employee_id = ? AND status = 'active'"
    ).get(employee.id);
    if (busy) throw err('EMPLOYEE_BUSY', '该员工已有进行中的辅导计划');

    const at = nowIso();
    const m = db.prepare(
      `INSERT INTO matches (application_id, mentor_id, employee_id, supervisor_id, status, created_at, confirmed_at)
       VALUES (?,?,?,?,'active',?,?)`
    ).run(a.id, mentorId, employee.id, user.id, at, at);
    const matchId = Number(m.lastInsertRowid);
    db.prepare("UPDATE applications SET status='matched', updated_at=? WHERE id=?").run(at, appId);

    // 主管确认后自动生成辅导计划，初始目标来自申请技能
    const skills = jparse(a.skills, []);
    const p = db.prepare(
      "INSERT INTO plans (match_id, title, status, created_at) VALUES (?,?,'active',?)"
    ).run(matchId, `${employee.name} × ${mentor.name} 辅导计划`, at);
    const planId = Number(p.lastInsertRowid);
    skills.forEach((s, i) => {
      db.prepare(
        "INSERT INTO goals (plan_id, seq, title, detail, status, created_at) VALUES (?,?,?,?,'open',?)"
      ).run(planId, i + 1, `提升：${s}`, '由匹配申请自动生成，可在辅导中细化', at);
    });

    messaging.send(db, employee.id, 'matched', '配对成功',
      `主管 ${user.name} 已确认您与导师 ${mentor.name} 的配对，辅导计划 #${planId} 已生成。`);
    messaging.send(db, mentorId, 'matched', '新的辅导计划',
      `主管 ${user.name} 已将员工 ${employee.name} 配对给您，计划 #${planId} 已生成，本月名额 ${count + 1}/${profile.monthly_capacity}。`);
    logAccess(db, user.id, 'confirm_match', 'match', matchId,
      `确认配对：员工 ${employee.name} × 导师 ${mentor.name}，计划#${planId}`);
    return { matchId, planId };
  });
}

function rejectApplication(db, user, appId, note) {
  const a = getApplication(db, appId);
  if (a.status !== 'pending') throw err('STATUS', '该申请不在待确认状态');
  const employee = getUser(db, a.employee_id);
  const depts = [employee.department];
  if (a.preferred_mentor_id) depts.push(getUser(db, a.preferred_mentor_id).department);
  assertNotRecused(user, depts);
  db.prepare("UPDATE applications SET status='rejected', review_note=?, updated_at=? WHERE id=?")
    .run(note || '', nowIso(), appId);
  messaging.send(db, employee.id, 'rejected', '匹配申请未通过', note || '主管未通过您的申请。');
  logAccess(db, user.id, 'reject_application', 'application', appId, note || '');
}

// ---------- 计划 / 目标 / 纪要 ----------

function addGoal(db, user, planId, { title, detail, targetDate }) {
  const ctx = planContext(db, planId);
  if (!isParty(user, ctx)) throw err('FORBIDDEN', '仅计划双方可添加目标');
  if (ctx.plan_status !== 'active') throw err('STATUS', '计划不在进行中，无法添加目标');
  if (!title) throw err('VALIDATION', '目标标题不能为空');
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM goals WHERE plan_id=?').get(planId).m;
  const r = db.prepare(
    "INSERT INTO goals (plan_id, seq, title, detail, status, target_date, created_at) VALUES (?,?,?,?,'open',?,?)"
  ).run(planId, maxSeq + 1, title, detail || '', targetDate || null, nowIso());
  return { id: Number(r.lastInsertRowid) };
}

function setGoalStatus(db, user, goalId, status) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
  if (!g) throw err('NOT_FOUND', '目标不存在');
  const ctx = planContext(db, g.plan_id);
  if (!isParty(user, ctx)) throw err('FORBIDDEN', '仅计划双方可更新目标');
  if (!['open', 'done', 'dropped'].includes(status)) throw err('VALIDATION', '非法目标状态');
  db.prepare('UPDATE goals SET status=? WHERE id=?').run(status, goalId);
}

// 预约辅导次：校验导师/员工在该时间段不与既有安排冲突
function scheduleSession(db, user, planId, { goalId, scheduledAt, durationMin }) {
  const ctx = planContext(db, planId);
  if (!isParty(user, ctx)) throw err('FORBIDDEN', '仅计划双方可安排辅导');
  if (ctx.plan_status !== 'active') throw err('STATUS', '计划不在进行中，无法安排辅导');
  if (!scheduledAt) throw err('VALIDATION', '请选择辅导时间');
  const dur = Number(durationMin) > 0 ? Number(durationMin) : 60;
  const end = addMinutesIso(scheduledAt, dur);

  const clash = (who, userId) => {
    const rows = db.prepare(
      `SELECT s.id, s.scheduled_at, s.duration_min FROM sessions s
       JOIN plans p ON p.id = s.plan_id
       JOIN matches m ON m.id = p.match_id
       WHERE (m.mentor_id = ? OR m.employee_id = ?) AND m.status = 'active'`
    ).all(userId, userId);
    for (const r of rows) {
      const rEnd = addMinutesIso(r.scheduled_at, r.duration_min);
      if (scheduledAt < rEnd && r.scheduled_at < end) {
        throw err('CONFLICT', `时间冲突：${who}在 ${r.scheduled_at.replace('T', ' ')} 已有辅导安排（第${r.id}次）`);
      }
    }
  };
  clash('导师', ctx.mentor_id);
  clash('员工', ctx.employee_id);

  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM sessions WHERE plan_id=?').get(planId).m;
  const r = db.prepare(
    `INSERT INTO sessions (plan_id, goal_id, seq, scheduled_at, duration_min, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(planId, goalId || null, maxSeq + 1, scheduledAt, dur, user.id, nowIso());
  const other = user.id === ctx.mentor_id ? ctx.employee_id : ctx.mentor_id;
  messaging.send(db, other, 'session_scheduled', '新的辅导安排',
    `计划 #${planId} 安排了第 ${maxSeq + 1} 次辅导：${scheduledAt.replace('T', ' ')}（${dur} 分钟）。`);
  return { id: Number(r.lastInsertRowid) };
}

// 记录纪要（按次）：公开纪要 + 下次目标
function completeSession(db, user, sessionId, { summary, nextGoals, heldAt }) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s) throw err('NOT_FOUND', '辅导次不存在');
  const ctx = planContext(db, s.plan_id);
  if (!isParty(user, ctx)) throw err('FORBIDDEN', '仅计划双方可记录纪要');
  db.prepare('UPDATE sessions SET held_at=?, summary=?, next_goals=? WHERE id=?')
    .run(heldAt || nowIso(), summary || '', nextGoals || '', sessionId);
  db.prepare('UPDATE plans SET started_at = COALESCE(started_at, ?) WHERE id=?')
    .run(nowIso(), s.plan_id);
}

// 私人反馈：作者强制为当前登录人 —— 导师不能替员工提交反馈
function addFeedback(db, user, planId, { sessionId, body, claimedAuthorId }) {
  const ctx = planContext(db, planId);
  if (!isParty(user, ctx)) throw err('FORBIDDEN', '仅计划双方可提交私人反馈');
  if (claimedAuthorId != null && Number(claimedAuthorId) !== user.id) {
    throw err('FORBIDDEN', '不能代替他人提交反馈');
  }
  if (!body || !String(body).trim()) throw err('VALIDATION', '反馈内容不能为空');
  if (ctx.plan_status !== 'active' && ctx.plan_status !== 'closing') {
    throw err('STATUS', '计划已结束，无法提交反馈');
  }
  const r = db.prepare(
    'INSERT INTO feedback (plan_id, session_id, author_id, body, created_at) VALUES (?,?,?,?,?)'
  ).run(planId, sessionId || null, user.id, String(body).trim(), nowIso());
  logAccess(db, user.id, 'add_feedback', 'plan', planId, '');
  return { id: Number(r.lastInsertRowid) };
}

// ---------- 换导师 ----------

function requestMentorChange(db, user, planId, { reason, preferredMentorId }) {
  const ctx = planContext(db, planId);
  if (user.id !== ctx.employee_id) throw err('FORBIDDEN', '仅员工本人可发起换导师申请');
  if (ctx.plan_status !== 'active' && ctx.plan_status !== 'suspended') {
    throw err('STATUS', '当前计划状态不支持换导师');
  }
  const dup = db.prepare(
    "SELECT id FROM change_requests WHERE plan_id = ? AND status = 'pending'"
  ).get(planId);
  if (dup) throw err('STATUS', '已有待审核的换导师申请');
  if (preferredMentorId) {
    if (Number(preferredMentorId) === ctx.mentor_id) throw err('VALIDATION', '新导师与现任导师相同');
    const p = getMentorProfile(db, preferredMentorId);
    if (!p.active) throw err('VALIDATION', '所选导师已不可申请');
  }
  const r = db.prepare(
    `INSERT INTO change_requests (plan_id, employee_id, old_mentor_id, preferred_mentor_id, reason, status, created_at)
     VALUES (?,?,?,?,?,'pending',?)`
  ).run(planId, ctx.employee_id, ctx.mentor_id, preferredMentorId || null, reason || '', nowIso());
  messaging.send(db, ctx.mentor_id, 'change_requested', '员工申请换导师',
    `员工 ${ctx.employee_name} 就计划 #${planId} 提交了换导师申请，等待主管审核。`);
  logAccess(db, user.id, 'request_mentor_change', 'plan', planId, reason || '');
  return { id: Number(r.lastInsertRowid) };
}

function cancelChangeRequest(db, user, reqId) {
  const req = db.prepare('SELECT * FROM change_requests WHERE id = ?').get(reqId);
  if (!req) throw err('NOT_FOUND', '申请不存在');
  if (req.employee_id !== user.id && user.role !== 'admin') throw err('FORBIDDEN', '仅本人可撤销');
  if (req.status !== 'pending') throw err('STATUS', '该申请已处理');
  db.prepare("UPDATE change_requests SET status='cancelled', reviewed_at=? WHERE id=?").run(nowIso(), reqId);
}

// 审核换导师：通过则旧配对结束、旧计划转移，新配对+新计划在同事务内生成（含容量与冲突检查）
function reviewChangeRequest(db, user, reqId, approve, { note, newMentorId } = {}) {
  const req = db.prepare('SELECT * FROM change_requests WHERE id = ?').get(reqId);
  if (!req) throw err('NOT_FOUND', '换导师申请不存在');
  if (req.status !== 'pending') throw err('STATUS', '该申请已处理');
  const ctx = planContext(db, req.plan_id);
  const mentorId = approve ? Number(newMentorId || req.preferred_mentor_id) : null;
  if (approve && !mentorId) throw err('VALIDATION', '通过申请时必须指定新导师');
  const newMentor = mentorId ? getUser(db, mentorId) : null;

  // 回避：与员工、原导师或新导师同部门的主管需回避
  assertNotRecused(user,
    [ctx.employee_department, ctx.mentor_department, newMentor && newMentor.department]);

  if (!approve) {
    db.prepare(
      "UPDATE change_requests SET status='rejected', reviewer_id=?, review_note=?, reviewed_at=? WHERE id=?"
    ).run(user.id, note || '', nowIso(), reqId);
    if (ctx.plan_status === 'suspended') {
      // 导师离职场景下驳回：计划保持挂起，等待重新发起
    }
    messaging.send(db, req.employee_id, 'change_rejected', '换导师申请未通过', note || '');
    logAccess(db, user.id, 'review_change_reject', 'change_request', reqId, note || '');
    return { approved: false };
  }

  if (newMentor.role !== 'mentor') throw err('VALIDATION', '新导师无效');
  const profile = getMentorProfile(db, mentorId);
  if (!profile.active || !newMentor.active) throw err('VALIDATION', '新导师已离职或停用');

  // 时段冲突预检（在事务外给出友好提示；容量在事务内强校验）
  const employee = getUser(db, req.employee_id);
  const latestApp = db.prepare(
    'SELECT * FROM applications WHERE employee_id = ? ORDER BY id DESC LIMIT 1'
  ).get(employee.id);
  const wantSlots = latestApp ? jparse(latestApp.slots, []) : [];
  if (wantSlots.length && !anyOverlap(wantSlots, mentorSlots(db, mentorId))) {
    throw err('CONFLICT', `员工可交流时段与新导师 ${newMentor.name} 的可带时段无交集，请选择其他导师`);
  }

  return txImmediate(db, () => {
    const count = activeMatchCount(db, mentorId);
    if (count >= profile.monthly_capacity) {
      throw err('CAPACITY_FULL',
        `导师 ${newMentor.name} 本月名额已满（${count}/${profile.monthly_capacity}），无法转入`);
    }
    const at = nowIso();
    // 旧配对结束、旧计划转移
    db.prepare("UPDATE matches SET status='ended', end_reason='changed', ended_at=? WHERE id=?")
      .run(at, ctx.match_id);
    db.prepare("UPDATE plans SET status='transferred', closed_at=? WHERE id=?").run(at, req.plan_id);
    // 新配对 + 新计划（承接目标）
    const m = db.prepare(
      `INSERT INTO matches (application_id, mentor_id, employee_id, supervisor_id, status, created_at, confirmed_at)
       VALUES (NULL,?,?,?,'active',?,?)`
    ).run(mentorId, req.employee_id, user.id, at, at);
    const newMatchId = Number(m.lastInsertRowid);
    const p = db.prepare(
      `INSERT INTO plans (match_id, title, status, previous_plan_id, created_at)
       VALUES (?,?,'active',?,?)`
    ).run(newMatchId, `${ctx.employee_name} × ${newMentor.name} 辅导计划`, req.plan_id, at);
    const newPlanId = Number(p.lastInsertRowid);
    const oldGoals = listGoals(db, req.plan_id);
    oldGoals.forEach((g) => {
      db.prepare(
        'INSERT INTO goals (plan_id, seq, title, detail, status, target_date, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(newPlanId, g.seq, g.title, g.detail, g.status === 'dropped' ? 'dropped' : g.status,
        g.target_date, at);
    });
    db.prepare(
      "UPDATE change_requests SET status='approved', reviewer_id=?, review_note=?, reviewed_at=? WHERE id=?"
    ).run(user.id, note || '', at, reqId);

    messaging.send(db, req.employee_id, 'change_approved', '换导师申请已通过',
      `已由主管 ${user.name} 审核，新导师为 ${newMentor.name}，新计划 #${newPlanId} 已生成并承接原目标。`);
    messaging.send(db, ctx.mentor_id, 'change_approved', '辅导关系已转移',
      `员工 ${ctx.employee_name} 的辅导已转移至导师 ${newMentor.name}，原计划 #${req.plan_id} 已归档。`);
    messaging.send(db, mentorId, 'change_approved', '新的辅导计划（转入）',
      `员工 ${ctx.employee_name} 由导师 ${ctx.mentor_name} 处转入，新计划 #${newPlanId}，本月名额 ${count + 1}/${profile.monthly_capacity}。`);
    logAccess(db, user.id, 'review_change_approve', 'change_request', reqId,
      `计划#${req.plan_id} → 新计划#${newPlanId}，新导师 ${newMentor.name}`);
    return { approved: true, newPlanId, newMatchId };
  });
}

// ---------- 结项审核（含提前完成） ----------

function requestClosure(db, user, planId, { type, reason }) {
  const ctx = planContext(db, planId);
  if (!isParty(user, ctx)) throw err('FORBIDDEN', '仅计划双方可发起结项申请');
  if (ctx.plan_status !== 'active') throw err('STATUS', '计划不在进行中');
  if (!['early', 'completed'].includes(type)) throw err('VALIDATION', '非法结项类型');
  const dup = db.prepare(
    "SELECT id FROM closure_requests WHERE plan_id = ? AND status = 'pending'"
  ).get(planId);
  if (dup) throw err('STATUS', '已有待审核的结项申请');
  const r = db.prepare(
    `INSERT INTO closure_requests (plan_id, requested_by, type, reason, status, created_at)
     VALUES (?,?,?,?,'pending',?)`
  ).run(planId, user.id, type, reason || '', nowIso());
  db.prepare("UPDATE plans SET status='closing' WHERE id=?").run(planId);
  logAccess(db, user.id, 'request_closure', 'plan', planId,
    `${type === 'early' ? '提前完成' : '正常结项'}：${reason || ''}`);
  return { id: Number(r.lastInsertRowid) };
}

function reviewClosure(db, user, reqId, approve, { note } = {}) {
  const req = db.prepare('SELECT * FROM closure_requests WHERE id = ?').get(reqId);
  if (!req) throw err('NOT_FOUND', '结项申请不存在');
  if (req.status !== 'pending') throw err('STATUS', '该申请已处理');
  const ctx = planContext(db, req.plan_id);
  assertNotRecused(user, [ctx.employee_department, ctx.mentor_department]);

  return txImmediate(db, () => {
    const at = nowIso();
    if (approve) {
      db.prepare("UPDATE plans SET status='closed', close_type=?, closed_at=? WHERE id=?")
        .run(req.type, at, req.plan_id);
      db.prepare("UPDATE matches SET status='ended', end_reason=?, ended_at=? WHERE id=?")
        .run(req.type === 'early' ? 'early_completed' : 'completed', at, ctx.match_id);
      db.prepare(
        "UPDATE closure_requests SET status='approved', reviewer_id=?, review_note=?, reviewed_at=? WHERE id=?"
      ).run(user.id, note || '', at, reqId);
      const label = req.type === 'early' ? '提前完成' : '正常结项';
      messaging.send(db, ctx.employee_id, 'closure_approved', `计划已${label}`,
        `计划 #${req.plan_id} 经主管 ${user.name} 审核通过，已${label}。`);
      messaging.send(db, ctx.mentor_id, 'closure_approved', `计划已${label}`,
        `计划 #${req.plan_id} 经主管 ${user.name} 审核通过，已${label}，本月名额已释放。`);
      logAccess(db, user.id, 'review_closure_approve', 'closure_request', reqId,
        `计划#${req.plan_id} ${label}`);
    } else {
      db.prepare("UPDATE plans SET status='active' WHERE id=?").run(req.plan_id);
      db.prepare(
        "UPDATE closure_requests SET status='rejected', reviewer_id=?, review_note=?, reviewed_at=? WHERE id=?"
      ).run(user.id, note || '', at, reqId);
      messaging.send(db, req.requested_by, 'closure_rejected', '结项申请未通过', note || '');
      logAccess(db, user.id, 'review_closure_reject', 'closure_request', reqId, note || '');
    }
    return { approved: !!approve };
  });
}

// ---------- 导师离职 ----------

function markMentorDeparted(db, user, mentorId) {
  if (user.role !== 'admin') throw err('FORBIDDEN', '仅管理员可标记导师离职');
  const mentor = getUser(db, mentorId);
  if (mentor.role !== 'mentor') throw err('VALIDATION', '该用户不是导师');
  const profile = getMentorProfile(db, mentorId);
  if (!profile.active) throw err('STATUS', '该导师已标记离职');

  return txImmediate(db, () => {
    const at = nowIso();
    db.prepare('UPDATE mentor_profiles SET active=0, left_at=? WHERE user_id=?').run(at, mentorId);
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(mentorId);
    const actives = db.prepare(
      "SELECT * FROM matches WHERE mentor_id = ? AND status = 'active'"
    ).all(mentorId);
    let affected = 0;
    for (const m of actives) {
      db.prepare("UPDATE matches SET status='ended', end_reason='mentor_left', ended_at=? WHERE id=?")
        .run(at, m.id);
      const plan = db.prepare("SELECT * FROM plans WHERE match_id=? AND status IN ('active','closing')")
        .get(m.id);
      if (plan) {
        db.prepare("UPDATE plans SET status='suspended' WHERE id=?").run(plan.id);
        db.prepare(
          `INSERT INTO change_requests (plan_id, employee_id, old_mentor_id, preferred_mentor_id, reason, status, created_at)
           VALUES (?,?,?,NULL,?,'pending',?)`
        ).run(plan.id, m.employee_id, mentorId, '导师离职，系统自动发起换导师，请主管重新指派', at);
        messaging.send(db, m.employee_id, 'mentor_left', '导师离职，计划挂起',
          `您的导师 ${mentor.name} 已离职，计划 #${plan.id} 已挂起，系统已自动发起换导师流程，请等待主管处理。`);
        affected += 1;
      }
    }
    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
    for (const a of admins) {
      messaging.send(db, a.id, 'mentor_left', '导师离职通知',
        `导师 ${mentor.name} 已标记离职，${affected} 个进行中计划已挂起并自动生成换导师申请。`);
    }
    logAccess(db, user.id, 'mentor_departed', 'user', mentorId,
      `导师 ${mentor.name} 离职，影响计划 ${affected} 个`);
    return { affected };
  });
}

// ---------- 导师档案 ----------

function updateMentorProfile(db, user, { expertise, monthlyCapacity, bio, department, slots }) {
  if (user.role !== 'mentor') throw err('FORBIDDEN', '仅导师可维护档案');
  const cap = Number(monthlyCapacity);
  if (!Number.isInteger(cap) || cap < 1 || cap > 20) throw err('VALIDATION', '每月可带人数需为 1-20 的整数');
  const inUse = activeMatchCount(db, user.id);
  if (cap < inUse) throw err('VALIDATION', `当前已有 ${inUse} 个进行中计划，容量不能低于该值`);
  txImmediate(db, () => {
    db.prepare('UPDATE mentor_profiles SET expertise=?, monthly_capacity=?, bio=? WHERE user_id=?')
      .run(JSON.stringify(expertise || []), cap, bio || '', user.id);
    if (department) db.prepare('UPDATE users SET department=? WHERE id=?').run(department, user.id);
    db.prepare('DELETE FROM mentor_slots WHERE mentor_id=?').run(user.id);
    for (const s of slots || []) {
      db.prepare('INSERT INTO mentor_slots (mentor_id, weekday, start_min, end_min) VALUES (?,?,?,?)')
        .run(user.id, s.weekday, s.start_min, s.end_min);
    }
  });
  logAccess(db, user.id, 'update_profile', 'user', user.id, '');
}

module.exports = {
  BizError,
  getUser, getMentorProfile, activeMatchCount, remainingCapacity, mentorSlots, listMentors,
  getApplication, getMatch, getPlan, planContext, listGoals, listSessions, listAttachments,
  isSupervisorLike, isParty, canViewPlan, assertCanViewPlan, canViewFeedback,
  recusalReason, assertNotRecused, logAccess, viewFeedback,
  createApplication, cancelApplication, confirmApplication, rejectApplication,
  addGoal, setGoalStatus, scheduleSession, completeSession, addFeedback,
  requestMentorChange, cancelChangeRequest, reviewChangeRequest,
  requestClosure, reviewClosure, markMentorDeparted, updateMentorProfile,
};
