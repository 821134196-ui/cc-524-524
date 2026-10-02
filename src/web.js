'use strict';
// HTTP 层：路由 + 服务端渲染。零依赖（node:http）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const svc = require('./services');
const messaging = require('./messaging');
const reminders = require('./reminders');
const {
  esc, fmtDT, fmtDate, slotLabel, jparse, parseCookies, readBody, asArray,
  WEEKDAYS, toMin, nowIso,
} = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ATTACH_DIR = process.env.MENTOR_ATTACH_DIR || path.join(__dirname, '..', 'attachments');

const APP_STATUS = { pending: '待确认', matched: '已配对', rejected: '已驳回', conflict: '时段冲突', cancelled: '已取消' };
const PLAN_STATUS = { active: '进行中', closing: '结项审核中', closed: '已结项', transferred: '已转移', suspended: '已挂起' };
const REQ_STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回', cancelled: '已撤销' };
const GOAL_STATUS = { open: '进行中', done: '已完成', dropped: '已放弃' };

function createServer(db) {
  // ---------- 基础 ----------
  function sendHtml(res, html, status) {
    res.writeHead(status || 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  function redirect(res, loc) {
    res.writeHead(303, { Location: loc });
    res.end();
  }
  function withFlash(to, key, msg) {
    const u = new URL(to, 'http://local');
    u.searchParams.delete('ok'); u.searchParams.delete('err');
    u.searchParams.set(key, msg);
    return u.pathname + u.search;
  }
  const ok = (res, to, msg) => redirect(res, withFlash(to, 'ok', msg));
  const fail = (res, to, msg) => redirect(res, withFlash(to, 'err', msg));

  function currentUser(req) {
    const id = Number(parseCookies(req).uid);
    if (!id) return null;
    try {
      const u = svc.getUser(db, id);
      return u.active ? u : null;
    } catch { return null; }
  }

  // ---------- 视图组件 ----------
  function badge(text, tone) {
    return `<span class="badge badge-${tone || 'gray'}">${esc(text)}</span>`;
  }
  function planBadge(s) {
    const tones = { active: 'green', closing: 'amber', closed: 'gray', transferred: 'blue', suspended: 'red' };
    return badge(PLAN_STATUS[s] || s, tones[s]);
  }
  function goalBadge(s) {
    const tones = { open: 'green', done: 'gray', dropped: 'red' };
    return badge(GOAL_STATUS[s] || s, tones[s]);
  }

  function layout(user, title, body, query) {
    const flashOk = query && query.get('ok');
    const flashErr = query && query.get('err');
    const nav = [];
    nav.push(['/', '工作台']);
    nav.push(['/mentors', '导师目录']);
    if (user.role === 'employee') nav.push(['/match', '匹配申请']);
    if (user.role === 'employee') nav.push(['/changes', '换导师']);
    if (user.role === 'mentor') nav.push(['/profile', '导师档案']);
    if (user.role === 'supervisor' || user.role === 'admin') nav.push(['/review', '审核台']);
    if (user.role === 'admin') nav.push(['/admin', '系统管理']);
    return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 导师制辅导平台</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<header class="topbar">
  <div class="brand"><span class="brand-dot"></span>导师制辅导平台</div>
  <nav>${nav.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}</nav>
  <div class="who">
    <span>${esc(user.name)} · ${esc({ employee: '员工', mentor: '导师', supervisor: '主管', admin: '管理员' }[user.role])} · ${esc(user.department)}</span>
    <a class="logout" href="/logout">退出</a>
  </div>
</header>
<main class="wrap">
${flashOk ? `<div class="flash flash-ok">${esc(flashOk)}</div>` : ''}
${flashErr ? `<div class="flash flash-err">${esc(flashErr)}</div>` : ''}
${body}
</main>
<script src="/static/app.js"></script>
</body></html>`;
  }

  function mentorOptions(selectedId, excludeId) {
    return svc.listMentors(db)
      .filter((m) => m.mentor_active && m.user_active && m.id !== excludeId)
      .map((m) => `<option value="${m.id}" ${m.id === Number(selectedId) ? 'selected' : ''}>${esc(m.name)} · ${esc(m.department)} · ${esc(m.expertise.join(' / '))} · 剩余名额 ${m.remaining}/${m.monthly_capacity}</option>`)
      .join('');
  }

  function slotCheckboxes(name) {
    // 常见晚间/周末时段
    const presets = [];
    for (const wd of [1, 2, 3, 4, 5]) presets.push({ weekday: wd, start: '19:00', end: '20:00' });
    presets.push({ weekday: 6, start: '10:00', end: '11:00' });
    presets.push({ weekday: 7, start: '14:00', end: '15:00' });
    return presets.map((s) => {
      const v = `${s.weekday}|${s.start}|${s.end}`;
      return `<label class="chip-check"><input type="checkbox" name="${name}" value="${v}"> ${esc(slotLabel(s))}</label>`;
    }).join('');
  }

  function parseSlotsField(v) {
    return asArray(v).map((s) => {
      const [weekday, start, end] = String(s).split('|');
      return { weekday: Number(weekday), start, end };
    }).filter((s) => s.weekday && s.start && s.end);
  }

  function mentorCard(m) {
    const full = m.remaining <= 0;
    return `<div class="card mentor-card">
  <div class="mentor-head">
    <span class="mentor-name">${esc(m.name)}</span>
    ${badge(m.department, 'gray')}
    ${m.mentor_active ? (full ? badge('名额已满', 'red') : badge(`剩余名额 ${m.remaining}/${m.monthly_capacity}`, 'green')) : badge('已离职', 'red')}
  </div>
  <div class="tags">${m.expertise.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
  <div class="muted small">可交流时段：${m.slots.map(slotLabel).join('；') || '—'}</div>
  <div class="muted small">${esc(m.bio)}</div>
</div>`;
  }

  // ---------- 页面 ----------

  function loginPage(query) {
    const users = db.prepare("SELECT * FROM users WHERE active=1 ORDER BY CASE role WHEN 'employee' THEN 1 WHEN 'mentor' THEN 2 WHEN 'supervisor' THEN 3 ELSE 4 END, id").all();
    const roleName = { employee: '员工', mentor: '导师', supervisor: '主管', admin: '管理员' };
    const groups = {};
    for (const u of users) (groups[u.role] = groups[u.role] || []).push(u);
    const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · 导师制辅导平台</title><link rel="stylesheet" href="/static/style.css"></head>
<body class="login-body">
<div class="login-card">
  <h1><span class="brand-dot"></span> 导师制辅导平台</h1>
  <p class="muted">演示环境：选择身份直接登录</p>
  ${query && query.get('err') ? `<div class="flash flash-err">${esc(query.get('err'))}</div>` : ''}
  ${Object.keys(groups).map((role) => `
    <div class="login-group"><h3>${roleName[role]}</h3>
    ${groups[role].map((u) => `<form method="post" action="/login" class="login-form">
      <input type="hidden" name="uid" value="${u.id}">
      <button type="submit" class="btn btn-ghost">${esc(u.name)}<span class="muted"> · ${esc(u.department)}</span></button>
    </form>`).join('')}</div>`).join('')}
</div></body></html>`;
    return body;
  }

  function dashboardPage(user) {
    const msgs = messaging.listForUser(db, user.id, 8);
    let html = `<h1>工作台</h1><div class="grid-2">`;

    // 左栏：角色相关
    html += `<div>`;
    if (user.role === 'employee') {
      const apps = db.prepare(
        `SELECT a.*, u.name AS mentor_name FROM applications a
         LEFT JOIN users u ON u.id = a.preferred_mentor_id
         WHERE a.employee_id = ? ORDER BY a.id DESC LIMIT 5`
      ).all(user.id);
      html += `<section class="card"><h2>我的匹配申请</h2>
        ${apps.length ? `<table><tr><th>技能</th><th>期望导师</th><th>状态</th><th>提交时间</th></tr>${apps.map((a) =>
        `<tr><td>${jparse(a.skills, []).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</td>
         <td>${esc(a.mentor_name || '不限')}</td><td>${badge(APP_STATUS[a.status], a.status === 'matched' ? 'green' : a.status === 'pending' ? 'amber' : 'gray')}</td>
         <td class="muted">${fmtDT(a.created_at)}</td></tr>`).join('')}</table>` : '<p class="muted">暂无申请</p>'}
        <p><a class="btn btn-primary" href="/match">发起匹配申请</a></p></section>`;
    }
    if (user.role === 'mentor') {
      const p = svc.getMentorProfile(db, user.id);
      const used = svc.activeMatchCount(db, user.id);
      html += `<section class="card"><h2>我的辅导容量</h2>
        <p class="big-stat">${used} <span class="muted">/ ${p.monthly_capacity} 人（本月）</span></p>
        <p class="muted">擅长领域：${jparse(p.expertise, []).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</p>
        <p><a class="btn btn-ghost" href="/profile">维护导师档案</a></p></section>`;
    }
    if (user.role === 'supervisor' || user.role === 'admin') {
      const pa = db.prepare("SELECT COUNT(*) c FROM applications WHERE status='pending'").get().c;
      const pc = db.prepare("SELECT COUNT(*) c FROM change_requests WHERE status='pending'").get().c;
      const pl = db.prepare("SELECT COUNT(*) c FROM closure_requests WHERE status='pending'").get().c;
      html += `<section class="card"><h2>待办审核</h2>
        <p class="big-stat">${pa + pc + pl} <span class="muted">项待处理</span></p>
        <p class="muted">配对确认 ${pa} · 换导师 ${pc} · 结项 ${pl}</p>
        <p><a class="btn btn-primary" href="/review">前往审核台</a></p></section>`;
    }

    // 我的计划（员工/导师/主管通用视图）
    const plans = db.prepare(
      `SELECT p.*, m.mentor_id, m.employee_id, mu.name AS mentor_name, eu.name AS employee_name,
        (SELECT COUNT(*) FROM sessions s WHERE s.plan_id = p.id) AS session_count,
        (SELECT COUNT(*) FROM reminder_flags f WHERE f.plan_id = p.id AND f.kind LIKE 'unstarted%') AS flagged
       FROM plans p JOIN matches m ON m.id = p.match_id
       JOIN users mu ON mu.id = m.mentor_id JOIN users eu ON eu.id = m.employee_id
       WHERE (m.employee_id = ? OR m.mentor_id = ?) ORDER BY p.id DESC`
    ).all(user.id, user.id);
    if (plans.length) {
      html += `<section class="card"><h2>我的辅导计划</h2><table>
        <tr><th>计划</th><th>状态</th><th>辅导次</th><th>创建</th></tr>
        ${plans.map((p) => `<tr>
          <td><a href="/plans/${p.id}">${esc(p.title)}</a>
            ${p.flagged ? badge('长期未开始', 'red') : ''}
            ${p.previous_plan_id ? `<span class="muted small">（由计划 #${p.previous_plan_id} 转入）</span>` : ''}</td>
          <td>${planBadge(p.status)}</td><td>${p.session_count}</td><td class="muted">${fmtDate(p.created_at)}</td></tr>`).join('')}
      </table></section>`;
    }
    html += `</div>`;

    // 右栏：消息回执
    html += `<div><section class="card"><h2>消息回执 <span class="muted small">模拟适配器</span></h2>
      ${msgs.length ? `<ul class="msg-list">${msgs.map((m) =>
        `<li><div class="msg-head">${badge(m.status === 'delivered' ? '已送达' : m.status, 'green')} <strong>${esc(m.title)}</strong>
          <span class="muted small">${fmtDT(m.created_at)}</span></div>
          <div class="muted">${esc(m.body)}</div></li>`).join('')}</ul>` : '<p class="muted">暂无消息</p>'}
    </section></div>`;

    html += `</div>`;
    return html;
  }

  function mentorsPage() {
    const ms = svc.listMentors(db);
    return `<h1>导师目录</h1>
    <p class="muted">导师姓名旁标注擅长领域与剩余名额；名额按“进行中计划数 / 每月可带人数”实时计算。</p>
    <div class="grid-2">${ms.map(mentorCard).join('')}</div>`;
  }

  function matchPage(user) {
    const skills = [...new Set(svc.listMentors(db).flatMap((m) => m.expertise))];
    const myApps = db.prepare(
      `SELECT a.*, u.name AS mentor_name FROM applications a
       LEFT JOIN users u ON u.id = a.preferred_mentor_id
       WHERE a.employee_id = ? ORDER BY a.id DESC`
    ).all(user.id);
    const mentors = svc.listMentors(db).filter((m) => m.mentor_active && m.user_active);
    return `<h1>匹配申请</h1>
<div class="grid-2">
<div>
<section class="card"><h2>发起申请</h2>
<form method="post" action="/applications" class="form">
  <label>希望提升的岗位技能</label>
  <div class="chip-row">${skills.map((s) => `<label class="chip-check"><input type="checkbox" name="skills" value="${esc(s)}"> ${esc(s)}</label>`).join('')}</div>
  <label>可交流时段</label>
  <div class="chip-row">${slotCheckboxes('slots')}</div>
  <label>期望导师（擅长领域与剩余名额见姓名旁）</label>
  <select name="preferred_mentor_id"><option value="">不限导师</option>${mentorOptions(null)}</select>
  <label>备注</label>
  <textarea name="note" rows="2" placeholder="职业目标、期望的辅导方式…"></textarea>
  <button class="btn btn-primary" type="submit">提交申请</button>
</form></section>

<section class="card"><h2>我的申请记录</h2>
${myApps.length ? `<table><tr><th>#</th><th>技能</th><th>时段</th><th>期望导师</th><th>状态</th><th></th></tr>
${myApps.map((a) => `<tr><td>${a.id}</td>
  <td>${jparse(a.skills, []).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</td>
  <td class="small">${jparse(a.slots, []).map(slotLabel).join('；')}</td>
  <td>${esc(a.mentor_name || '不限')}</td>
  <td>${badge(APP_STATUS[a.status], a.status === 'matched' ? 'green' : a.status === 'pending' ? 'amber' : a.status === 'conflict' ? 'red' : 'gray')}
    ${a.review_note ? `<div class="muted small">${esc(a.review_note)}</div>` : ''}</td>
  <td>${a.status === 'pending' ? `<form method="post" action="/applications/${a.id}/cancel" data-confirm="确定取消该申请？"><button class="btn btn-ghost btn-sm">取消</button></form>` : ''}</td>
</tr>`).join('')}</table>` : '<p class="muted">暂无申请记录</p>'}
</section>
</div>

<div><section class="card"><h2>可选导师</h2>
<p class="muted small">姓名旁即擅长领域与剩余名额。</p>
${mentors.map((m) => `<div class="mentor-line">
  <strong>${esc(m.name)}</strong>
  ${m.expertise.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
  ${m.remaining > 0 ? badge(`剩余名额 ${m.remaining}/${m.monthly_capacity}`, 'green') : badge('名额已满', 'red')}
  <div class="muted small">${esc(m.department)} · ${m.slots.map(slotLabel).join('；')}</div>
</div>`).join('')}
</section></div>
</div>`;
  }

  function reviewPage(user) {
    // 待确认申请
    const apps = db.prepare(
      `SELECT a.*, e.name AS employee_name, e.department AS employee_dept, pm.name AS pm_name, pm.department AS pm_dept
       FROM applications a
       JOIN users e ON e.id = a.employee_id
       LEFT JOIN users pm ON pm.id = a.preferred_mentor_id
       WHERE a.status = 'pending' ORDER BY a.id`
    ).all();
    const appRows = apps.map((a) => {
      const reason = svc.recusalReason(user, [a.employee_dept, a.pm_dept]);
      return `<tr><td>#${a.id}</td>
      <td>${esc(a.employee_name)}<div class="muted small">${esc(a.employee_dept)}</div></td>
      <td>${jparse(a.skills, []).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</td>
      <td class="small">${jparse(a.slots, []).map(slotLabel).join('；')}</td>
      <td>${esc(a.pm_name || '不限')}${a.pm_dept ? `<div class="muted small">${esc(a.pm_dept)}</div>` : ''}</td>
      <td>${reason ? `<span class="recusal">⚠ 需回避</span><div class="muted small">${esc(reason)}</div>` : `
        <form method="post" action="/review/applications/${a.id}/confirm" class="inline-form">
          <select name="mentor_id">${mentorOptions(a.preferred_mentor_id)}</select>
          <button class="btn btn-primary btn-sm" type="submit">确认配对</button>
        </form>
        <form method="post" action="/review/applications/${a.id}/reject" class="inline-form">
          <input name="note" placeholder="驳回原因" class="input-sm">
          <button class="btn btn-ghost btn-sm" type="submit">驳回</button>
        </form>`}</td></tr>`;
    }).join('');

    // 换导师审核
    const changes = db.prepare(
      `SELECT c.*, e.name AS employee_name, e.department AS employee_dept,
              om.name AS old_name, om.department AS old_dept,
              nm.name AS new_name, nm.department AS new_dept
       FROM change_requests c
       JOIN users e ON e.id = c.employee_id
       JOIN users om ON om.id = c.old_mentor_id
       LEFT JOIN users nm ON nm.id = c.preferred_mentor_id
       WHERE c.status = 'pending' ORDER BY c.id`
    ).all();
    const changeRows = changes.map((c) => {
      const reason = svc.recusalReason(user, [c.employee_dept, c.old_dept, c.new_dept]);
      return `<tr><td>#${c.id}</td>
      <td><a href="/plans/${c.plan_id}">计划 #${c.plan_id}</a></td>
      <td>${esc(c.employee_name)}<div class="muted small">${esc(c.employee_dept)}</div></td>
      <td>${esc(c.old_name)}<div class="muted small">${esc(c.old_dept)}</div></td>
      <td>${esc(c.new_name || '待主管指派')}${c.new_dept ? `<div class="muted small">${esc(c.new_dept)}</div>` : ''}</td>
      <td class="small">${esc(c.reason)}</td>
      <td>${reason ? `<span class="recusal">⚠ 需回避</span><div class="muted small">${esc(reason)}</div>` : `
        <form method="post" action="/review/changes/${c.id}/approve" class="inline-form">
          <select name="mentor_id">${mentorOptions(c.preferred_mentor_id, c.old_mentor_id)}</select>
          <button class="btn btn-primary btn-sm" type="submit">通过并转介</button>
        </form>
        <form method="post" action="/review/changes/${c.id}/reject" class="inline-form">
          <input name="note" placeholder="驳回原因" class="input-sm">
          <button class="btn btn-ghost btn-sm" type="submit">驳回</button>
        </form>`}</td></tr>`;
    }).join('');

    // 结项审核
    const closures = db.prepare(
      `SELECT r.*, p.title, e.name AS employee_name, e.department AS employee_dept,
              m.name AS mentor_name, m.department AS mentor_dept, u.name AS requester_name,
              (SELECT COUNT(*) FROM sessions s WHERE s.plan_id = p.id AND s.held_at IS NOT NULL) AS held,
              (SELECT COUNT(*) FROM goals g WHERE g.plan_id = p.id AND g.status='done') AS goals_done,
              (SELECT COUNT(*) FROM goals g WHERE g.plan_id = p.id) AS goals_total
       FROM closure_requests r
       JOIN plans p ON p.id = r.plan_id
       JOIN matches mt ON mt.id = p.match_id
       JOIN users e ON e.id = mt.employee_id
       JOIN users m ON m.id = mt.mentor_id
       JOIN users u ON u.id = r.requested_by
       WHERE r.status = 'pending' ORDER BY r.id`
    ).all();
    const closureRows = closures.map((r) => {
      const reason = svc.recusalReason(user, [r.employee_dept, r.mentor_dept]);
      return `<tr><td>#${r.id}</td>
      <td><a href="/plans/${r.plan_id}">${esc(r.title)}</a><div class="muted small">${esc(r.employee_name)} × ${esc(r.mentor_name)}</div></td>
      <td>${r.type === 'early' ? badge('提前完成', 'amber') : badge('正常结项', 'blue')}</td>
      <td class="small">目标 ${r.goals_done}/${r.goals_total} 完成 · 已辅导 ${r.held} 次</td>
      <td class="small">${esc(r.reason)}<div class="muted">${esc(r.requester_name)} 提交</div></td>
      <td>${reason ? `<span class="recusal">⚠ 需回避</span><div class="muted small">${esc(reason)}</div>` : `
        <form method="post" action="/review/closures/${r.id}/approve" class="inline-form" data-confirm="确认通过结项？名额将释放。">
          <button class="btn btn-primary btn-sm" type="submit">通过结项</button>
        </form>
        <form method="post" action="/review/closures/${r.id}/reject" class="inline-form">
          <input name="note" placeholder="驳回原因" class="input-sm">
          <button class="btn btn-ghost btn-sm" type="submit">驳回</button>
        </form>`}</td></tr>`;
    }).join('');

    return `<h1>审核台</h1>
<section class="card"><h2>待确认配对 <span class="muted small">容量在确认瞬间强校验，并发不会超占</span></h2>
${apps.length ? `<table><tr><th>#</th><th>员工</th><th>技能</th><th>可交流时段</th><th>期望导师</th><th>操作</th></tr>${appRows}</table>` : '<p class="muted">暂无待确认申请</p>'}
</section>
<section class="card"><h2>换导师审核</h2>
${changes.length ? `<table><tr><th>#</th><th>计划</th><th>员工</th><th>原导师</th><th>期望新导师</th><th>原因</th><th>操作</th></tr>${changeRows}</table>` : '<p class="muted">暂无换导师申请</p>'}
</section>
<section class="card"><h2>结项审核 <span class="muted small">含提前完成</span></h2>
${closures.length ? `<table><tr><th>#</th><th>计划</th><th>类型</th><th>进度</th><th>申请说明</th><th>操作</th></tr>${closureRows}</table>` : '<p class="muted">暂无结项申请</p>'}
</section>`;
  }

  function planPage(user, planId, query) {
    const ctx = svc.planContext(db, planId);
    svc.assertCanViewPlan(user, ctx);
    svc.logAccess(db, user.id, 'view_plan', 'plan', planId, '');

    const goals = svc.listGoals(db, planId);
    const sessions = svc.listSessions(db, planId);
    const attachments = svc.listAttachments(db, planId);
    const isParty = svc.isParty(user, ctx);
    const active = ctx.plan_status === 'active';
    const pendingClosure = db.prepare(
      "SELECT * FROM closure_requests WHERE plan_id=? AND status='pending'"
    ).get(planId);
    const pendingChange = db.prepare(
      "SELECT * FROM change_requests WHERE plan_id=? AND status='pending'"
    ).get(planId);
    const flags = db.prepare('SELECT * FROM reminder_flags WHERE plan_id=?').all(planId);
    const prevPlan = ctx.previous_plan_id ? svc.getPlan(db, ctx.previous_plan_id) : null;
    const nextPlan = db.prepare('SELECT id FROM plans WHERE previous_plan_id=?').get(planId);

    // 目标时间线：目标为节点，纪要挂在目标下展开
    const sessionsByGoal = {};
    const loose = [];
    for (const s of sessions) {
      if (s.goal_id && goals.some((g) => g.id === s.goal_id)) {
        (sessionsByGoal[s.goal_id] = sessionsByGoal[s.goal_id] || []).push(s);
      } else loose.push(s);
    }

    const sessionHtml = (s) => `<div class="session">
      <div class="session-head">
        <strong>第 ${s.seq} 次辅导</strong>
        <span class="muted">${fmtDT(s.scheduled_at)} · ${s.duration_min} 分钟</span>
        ${s.held_at ? badge('已进行', 'green') : badge('待进行', 'amber')}
      </div>
      ${s.held_at ? `<div class="session-body">
        <div><span class="lbl">公开纪要</span>${esc(s.summary || '—')}</div>
        <div><span class="lbl">下次目标</span>${esc(s.next_goals || '—')}</div>
      </div>` : ''}
      ${isParty && !s.held_at && active ? `
      <form method="post" action="/sessions/${s.id}/complete" class="session-complete">
        <input name="summary" placeholder="本次公开纪要" required>
        <input name="next_goals" placeholder="下次目标">
        <button class="btn btn-primary btn-sm">记录纪要</button>
      </form>` : ''}
    </div>`;

    const timeline = goals.map((g, i) => `
    <div class="tl-node">
      <div class="tl-dot tl-${g.status}"></div>
      <div class="tl-card">
        <details ${i === goals.length - 1 ? 'open' : ''}>
          <summary>
            <span class="tl-title">目标 ${g.seq}：${esc(g.title)}</span>
            ${goalBadge(g.status)}
            <span class="muted small">目标日期 ${esc(g.target_date || '—')}</span>
          </summary>
          <p class="muted">${esc(g.detail)}</p>
          ${isParty && active ? `<form method="post" action="/goals/${g.id}/status" class="inline-form">
            <select name="status">${['open', 'done', 'dropped'].map((s) => `<option value="${s}" ${s === g.status ? 'selected' : ''}>${GOAL_STATUS[s]}</option>`).join('')}</select>
            <button class="btn btn-ghost btn-sm">更新状态</button></form>` : ''}
          ${(sessionsByGoal[g.id] || []).map(sessionHtml).join('') || '<p class="muted small">该目标下暂无辅导次</p>'}
        </details>
      </div>
    </div>`).join('');

    // 私人反馈（授权才读取，读取即留痕）
    let feedbackBlock;
    if (svc.canViewFeedback(user, ctx)) {
      const fbs = svc.viewFeedback(db, user, planId);
      feedbackBlock = `<section class="private-panel">
  <h2>🔒 私人反馈 <span class="lock-note">仅当事双方与授权主管可见 · 本次查看已记入访问记录</span></h2>
  ${fbs.length ? fbs.map((f) => `<div class="fb-item">
      <div class="fb-head"><strong>${esc(f.author_name)}</strong>
        <span class="muted small">${f.author_role === 'mentor' ? '导师' : '员工'} · ${fmtDT(f.created_at)}${f.session_id ? ` · 关联第 ${f.session_id} 次` : ''}</span></div>
      <div>${esc(f.body)}</div>
    </div>`).join('') : '<p class="muted">暂无私人反馈</p>'}
  ${isParty && (active || ctx.plan_status === 'closing') ? `
  <form method="post" action="/plans/${planId}/feedback" class="form fb-form">
    <label>提交我的私人反馈（作者固定为本人，不能代他人提交）</label>
    <div class="fb-row">
      <select name="session_id"><option value="">不关联辅导次</option>
        ${sessions.filter((s) => s.held_at).map((s) => `<option value="${s.id}">第 ${s.seq} 次（${fmtDate(s.scheduled_at)}）</option>`).join('')}
      </select>
    </div>
    <textarea name="body" rows="2" required placeholder="仅双方与授权主管可见…"></textarea>
    <button class="btn btn-primary" type="submit">提交私人反馈</button>
  </form>` : ''}
</section>`;
    } else {
      feedbackBlock = `<section class="private-panel private-locked"><h2>🔒 私人反馈</h2>
        <p>该区域仅当事双方与授权主管可见。</p></section>`;
    }

    return `<h1>${esc(ctx.title)} ${planBadge(ctx.plan_status)}</h1>
<p class="muted">
  员工 <strong>${esc(ctx.employee_name)}</strong>（${esc(ctx.employee_department)}） ×
  导师 <strong>${esc(ctx.mentor_name)}</strong>（${esc(ctx.mentor_department)}） ·
  确认主管 ${esc(ctx.supervisor_name)} · 创建于 ${fmtDate(ctx.plan_created_at)}
  ${ctx.started_at ? ` · 首次辅导 ${fmtDate(ctx.started_at)}` : ''}
  ${ctx.closed_at ? ` · 结束于 ${fmtDate(ctx.closed_at)}` : ''}
</p>
${flags.length ? `<div class="flash flash-err">⚠ 该计划被提醒任务标记：${flags.map((f) => esc(f.kind === 'unstarted' ? '长期未开始' : f.kind === 'unstarted_escalated' ? '长期未开始（已升级主管）' : f.kind)).join('、')}</div>` : ''}
${prevPlan ? `<p>${badge('由换导师转入', 'blue')} <a href="/plans/${prevPlan.id}">查看原计划 #${prevPlan.id}</a></p>` : ''}
${nextPlan ? `<p>${badge('已转出', 'blue')} <a href="/plans/${nextPlan.id}">查看承接计划 #${nextPlan.id}</a></p>` : ''}
${pendingClosure ? `<p>${badge('结项审核中', 'amber')} ${pendingClosure.type === 'early' ? '提前完成' : '正常结项'}申请待主管审核。</p>` : ''}
${pendingChange ? `<p>${badge('换导师审核中', 'amber')} 申请待主管审核。</p>` : ''}

<div class="grid-2">
<div>
<section class="card"><h2>目标时间线 <span class="muted small">纪要按目标展开</span></h2>
  <div class="timeline">${timeline || '<p class="muted">暂无目标</p>'}</div>
  ${loose.length ? `<h3>未关联目标的辅导次</h3>${loose.map(sessionHtml).join('')}` : ''}
</section>
${feedbackBlock}
</div>

<div>
${isParty && active ? `<section class="card"><h2>安排与记录</h2>
  <form method="post" action="/plans/${planId}/sessions" class="form">
    <label>预约下一次辅导</label>
    <div class="fb-row">
      <select name="goal_id"><option value="">不关联目标</option>
        ${goals.filter((g) => g.status === 'open').map((g) => `<option value="${g.id}">目标 ${g.seq}：${esc(g.title)}</option>`).join('')}
      </select>
      <input type="number" name="duration_min" value="60" min="15" step="15" title="时长（分钟）">
    </div>
    <input type="datetime-local" name="scheduled_at" required>
    <button class="btn btn-primary" type="submit">预约辅导</button>
    <p class="muted small">系统自动校验导师与员工的时间冲突。</p>
  </form>
  <hr>
  <form method="post" action="/plans/${planId}/goals" class="form">
    <label>添加公开目标</label>
    <input name="title" placeholder="目标标题" required>
    <input name="detail" placeholder="目标说明">
    <input type="date" name="target_date">
    <button class="btn btn-ghost" type="submit">添加目标</button>
  </form>
</section>` : ''}

<section class="card"><h2>附件 <span class="muted small">本地存储</span></h2>
  ${attachments.length ? `<ul class="att-list">${attachments.map((a) =>
    `<li><a href="/attachments/${a.id}">📎 ${esc(a.filename)}</a>
      <span class="muted small">${esc(a.uploader_name)} · ${fmtDate(a.created_at)} · ${a.size}B</span></li>`).join('')}</ul>`
    : '<p class="muted">暂无附件</p>'}
  ${isParty && active ? `<form method="post" action="/plans/${planId}/attachments" class="form">
    <label>添加文本附件（虚构）</label>
    <input name="filename" placeholder="文件名，如 学习笔记.md" required>
    <textarea name="content" rows="2" placeholder="附件内容…" required></textarea>
    <button class="btn btn-ghost" type="submit">保存附件</button>
  </form>` : ''}
</section>

${isParty && active && !pendingChange && !pendingClosure ? `<section class="card"><h2>计划流转</h2>
  ${user.id === ctx.employee_id ? `
  <form method="post" action="/plans/${planId}/change-requests" class="form">
    <label>申请换导师</label>
    <select name="preferred_mentor_id"><option value="">由主管指派</option>${mentorOptions(null, ctx.mentor_id)}</select>
    <textarea name="reason" rows="2" placeholder="换导师原因…" required></textarea>
    <button class="btn btn-ghost" type="submit" data-confirm="提交换导师申请？">提交换导师申请</button>
  </form><hr>` : ''}
  <form method="post" action="/plans/${planId}/closure-requests" class="form">
    <label>申请结项</label>
    <div class="fb-row">
      <select name="type"><option value="completed">正常结项</option><option value="early">提前完成</option></select>
    </div>
    <textarea name="reason" rows="2" placeholder="结项说明…" required></textarea>
    <button class="btn btn-ghost" type="submit" data-confirm="提交结项申请？计划将进入审核。">提交结项申请</button>
  </form>
</section>` : ''}
</div>
</div>`;
  }

  function changesPage(user) {
    const reqs = db.prepare(
      `SELECT c.*, om.name AS old_name, nm.name AS new_name, rv.name AS reviewer_name
       FROM change_requests c
       JOIN users om ON om.id = c.old_mentor_id
       LEFT JOIN users nm ON nm.id = c.preferred_mentor_id
       LEFT JOIN users rv ON rv.id = c.reviewer_id
       WHERE c.employee_id = ? ORDER BY c.id DESC`
    ).all(user.id);
    return `<h1>换导师</h1>
<section class="card"><h2>我的换导师申请</h2>
${reqs.length ? `<table><tr><th>#</th><th>计划</th><th>原导师</th><th>期望新导师</th><th>原因</th><th>状态</th><th>审核</th><th></th></tr>
${reqs.map((r) => `<tr><td>${r.id}</td><td><a href="/plans/${r.plan_id}">#${r.plan_id}</a></td>
  <td>${esc(r.old_name)}</td><td>${esc(r.new_name || '由主管指派')}</td>
  <td class="small">${esc(r.reason)}</td>
  <td>${badge(REQ_STATUS[r.status], r.status === 'approved' ? 'green' : r.status === 'pending' ? 'amber' : 'gray')}</td>
  <td class="small">${r.reviewer_name ? `${esc(r.reviewer_name)} · ${fmtDT(r.reviewed_at)}${r.review_note ? `<div class="muted">${esc(r.review_note)}</div>` : ''}` : '—'}</td>
  <td>${r.status === 'pending' ? `<form method="post" action="/change-requests/${r.id}/cancel" data-confirm="撤销该申请？"><button class="btn btn-ghost btn-sm">撤销</button></form>` : ''}</td>
</tr>`).join('')}</table>` : '<p class="muted">暂无换导师申请。可在进行中的计划详情页发起。</p>'}
</section>
<section class="card"><h2>如何发起</h2>
<p class="muted">进入 <a href="/">工作台</a> → 打开进行中的辅导计划 → 「计划流转」→ 提交换导师申请。导师离职时系统会自动发起，无需手动操作。</p>
</section>`;
  }

  function profilePage(user) {
    const p = svc.getMentorProfile(db, user.id);
    const slots = svc.mentorSlots(db, user.id);
    return `<h1>导师档案</h1>
<section class="card"><h2>基本信息</h2>
<form method="post" action="/profile" class="form">
  <label>姓名 / 所属部门</label>
  <div class="fb-row">
    <input value="${esc(user.name)}" disabled>
    <input name="department" value="${esc(user.department)}" placeholder="所属部门">
  </div>
  <label>擅长领域（逗号分隔）</label>
  <input name="expertise" value="${esc(jparse(p.expertise, []).join('，'))}">
  <label>每月可带人数（当前已带 ${svc.activeMatchCount(db, user.id)} 人）</label>
  <input type="number" name="monthly_capacity" min="1" max="20" value="${p.monthly_capacity}">
  <label>个人简介</label>
  <textarea name="bio" rows="2">${esc(p.bio)}</textarea>
  <label>可交流时段</label>
  <div class="chip-row">${[1, 2, 3, 4, 5, 6, 7].map((wd) =>
    [`${wd}|19:00|20:00`, `${wd}|20:00|21:00`].map((v) => {
      const [w, s, e] = v.split('|');
      const checked = slots.some((x) => x.weekday === Number(w) && s === `${String(Math.floor(x.start_min / 60)).padStart(2, '0')}:${String(x.start_min % 60).padStart(2, '0')}`);
      return `<label class="chip-check"><input type="checkbox" name="slots" value="${w}|${s}|${e}" ${checked ? 'checked' : ''}> ${WEEKDAYS[wd]} ${s}–${e}</label>`;
    }).join('')).join('')}</div>
  <button class="btn btn-primary" type="submit">保存档案</button>
</form></section>`;
  }

  function adminPage(user) {
    const mentors = svc.listMentors(db);
    const msgs = messaging.listAll(db, 30);
    const logs = db.prepare(
      `SELECT l.*, u.name AS user_name FROM access_logs l JOIN users u ON u.id = l.user_id
       ORDER BY l.id DESC LIMIT 30`
    ).all();
    const flags = db.prepare(
      `SELECT f.*, p.title FROM reminder_flags f JOIN plans p ON p.id = f.plan_id ORDER BY f.id DESC LIMIT 20`
    ).all();
    return `<h1>系统管理</h1>
<div class="grid-2">
<section class="card"><h2>导师管理</h2>
<table><tr><th>导师</th><th>部门</th><th>容量</th><th>状态</th><th></th></tr>
${mentors.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.department)}</td>
  <td>${m.active_count}/${m.monthly_capacity}</td>
  <td>${m.mentor_active ? badge('在带', 'green') : badge('已离职', 'red')}</td>
  <td>${m.mentor_active ? `<form method="post" action="/admin/mentors/${m.id}/depart" data-confirm="标记 ${esc(m.name)} 离职？进行中计划将挂起并自动发起换导师。"><button class="btn btn-ghost btn-sm">标记离职</button></form>` : ''}</td></tr>`).join('')}
</table></section>

<section class="card"><h2>提醒任务 <span class="muted small">进程内定时，每 60 秒扫描</span></h2>
<form method="post" action="/admin/scan"><button class="btn btn-primary btn-sm">立即扫描</button></form>
${flags.length ? `<table><tr><th>计划</th><th>标记</th><th>时间</th></tr>
${flags.map((f) => `<tr><td><a href="/plans/${f.plan_id}">#${f.plan_id} ${esc(f.title)}</a></td>
<td>${badge(f.kind.startsWith('unstarted') ? (f.kind === 'unstarted' ? '长期未开始' : '已升级') : '辅导提醒', f.kind.startsWith('unstarted') ? 'red' : 'amber')}</td>
<td class="muted">${fmtDT(f.created_at)}</td></tr>`).join('')}</table>` : '<p class="muted">暂无提醒标记</p>'}
</section>
</div>

<section class="card"><h2>消息回执 <span class="muted small">模拟适配器，全量</span></h2>
<table><tr><th>#</th><th>收件人</th><th>类型</th><th>标题</th><th>状态</th><th>时间</th></tr>
${msgs.map((m) => `<tr><td>${m.id}</td><td>${esc(m.user_name)}</td><td class="small">${esc(m.kind)}</td>
<td>${esc(m.title)}</td><td>${badge('已送达', 'green')}</td><td class="muted">${fmtDT(m.created_at)}</td></tr>`).join('')}
</table></section>

<section class="card"><h2>访问记录 <span class="muted small">SQLite 持久化</span></h2>
<table><tr><th>#</th><th>用户</th><th>动作</th><th>对象</th><th>详情</th><th>时间</th></tr>
${logs.map((l) => `<tr><td>${l.id}</td><td>${esc(l.user_name)}</td><td class="small">${esc(l.action)}</td>
<td class="small">${esc(l.object_type)}${l.object_id ? '#' + l.object_id : ''}</td>
<td class="small">${esc(l.detail)}</td><td class="muted">${fmtDT(l.created_at)}</td></tr>`).join('')}
</table></section>`;
  }

  // ---------- 路由 ----------
  const routes = [];
  function on(method, pattern, handler, opts) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, handler, opts });
  }
  const GET = (p, h) => on('GET', p, h);
  const POST = (p, h) => on('POST', p, h);

  // 页面（GET）
  GET('/login', async (req, res, p, q) => sendHtml(res, loginPage(q)));
  GET('/logout', async (req, res) => {
    res.writeHead(303, { 'Set-Cookie': 'uid=; Path=/; Max-Age=0', Location: '/login' });
    res.end();
  });
  GET('/', async (req, res, p, q, user) => sendHtml(res, layout(user, '工作台', dashboardPage(user), q)));
  GET('/mentors', async (req, res, p, q, user) => sendHtml(res, layout(user, '导师目录', mentorsPage(), q)));
  GET('/match', async (req, res, p, q, user) => {
    if (user.role !== 'employee') return sendHtml(res, layout(user, '匹配申请', '<div class="card"><p>仅员工可发起匹配申请。</p></div>', q), 403);
    sendHtml(res, layout(user, '匹配申请', matchPage(user), q));
  });
  GET('/review', async (req, res, p, q, user) => {
    if (!svc.isSupervisorLike(user)) return sendHtml(res, layout(user, '审核台', '<div class="card"><p>仅主管与管理员可访问审核台。</p></div>', q), 403);
    sendHtml(res, layout(user, '审核台', reviewPage(user), q));
  });
  GET('/plans/:id', async (req, res, p, q, user) => {
    try {
      sendHtml(res, layout(user, `计划 #${p.id}`, planPage(user, Number(p.id), q), q));
    } catch (e) {
      const status = e.code === 'NOT_FOUND' ? 404 : 403;
      sendHtml(res, layout(user, '无权访问', `<div class="card"><h2>${esc(e.message)}</h2><p><a href="/">返回工作台</a></p></div>`, q), status);
    }
  });
  GET('/changes', async (req, res, p, q, user) => sendHtml(res, layout(user, '换导师', changesPage(user), q)));
  GET('/profile', async (req, res, p, q, user) => {
    if (user.role !== 'mentor') return sendHtml(res, layout(user, '导师档案', '<div class="card"><p>仅导师可维护档案。</p></div>', q), 403);
    sendHtml(res, layout(user, '导师档案', profilePage(user), q));
  });
  GET('/admin', async (req, res, p, q, user) => {
    if (user.role !== 'admin') return sendHtml(res, layout(user, '系统管理', '<div class="card"><p>仅管理员可访问。</p></div>', q), 403);
    sendHtml(res, layout(user, '系统管理', adminPage(user), q));
  });
  GET('/attachments/:id', async (req, res, p, q, user) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(p.id));
    if (!a) return sendHtml(res, layout(user, '附件', '<div class="card"><p>附件不存在</p></div>', q), 404);
    const ctx = svc.planContext(db, a.plan_id);
    try { svc.assertCanViewPlan(user, ctx); } catch (e) {
      return sendHtml(res, layout(user, '附件', `<div class="card"><p>${esc(e.message)}</p></div>`, q), 403);
    }
    svc.logAccess(db, user.id, 'download_attachment', 'attachment', a.id, a.filename);
    const file = path.join(ATTACH_DIR, path.basename(a.stored_name));
    if (!fs.existsSync(file)) return sendHtml(res, layout(user, '附件', '<div class="card"><p>附件文件缺失</p></div>', q), 404);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    });
    fs.createReadStream(file).pipe(res);
  });

  // 动作（POST）
  POST('/login', async (req, res) => {
    const body = await readBody(req);
    const uid = Number(body.uid);
    let u = null;
    try { u = svc.getUser(db, uid); } catch { /* ignore */ }
    if (!u || !u.active) return redirect(res, withFlash('/login', 'err', '用户不存在或已停用'));
    svc.logAccess(db, u.id, 'login', 'user', u.id, '');
    res.writeHead(303, { 'Set-Cookie': `uid=${u.id}; Path=/; HttpOnly`, Location: '/' });
    res.end();
  });

  // POST 动作统一包装：业务错误 → 回跳并闪现消息
  function act(handler) {
    return async (req, res, params, q, user) => {
      const body = await readBody(req);
      const ref = req.headers.referer || '/';
      const back = new URL(ref, 'http://local').pathname;
      try {
        await handler(req, res, params, body, user, back);
      } catch (e) {
        if (e && e.code) return fail(res, back, e.message);
        console.error(e);
        return fail(res, back, '服务器错误，请稍后重试');
      }
    };
  }

  POST('/applications', act(async (req, res, p, body, user) => {
    const r = svc.createApplication(db, user, {
      skills: asArray(body.skills),
      slots: parseSlotsField(body.slots),
      note: body.note,
      preferredMentorId: body.preferred_mentor_id ? Number(body.preferred_mentor_id) : null,
    });
    ok(res, '/match', `申请 #${r.id} 已提交，等待主管确认`);
  }));
  POST('/applications/:id/cancel', act(async (req, res, p, body, user) => {
    svc.cancelApplication(db, user, Number(p.id));
    ok(res, '/match', '申请已取消');
  }));
  POST('/review/applications/:id/confirm', act(async (req, res, p, body, user) => {
    const r = svc.confirmApplication(db, user, Number(p.id), Number(body.mentor_id));
    ok(res, '/review', `配对成功，辅导计划 #${r.planId} 已生成`);
  }));
  POST('/review/applications/:id/reject', act(async (req, res, p, body, user) => {
    svc.rejectApplication(db, user, Number(p.id), body.note);
    ok(res, '/review', '申请已驳回');
  }));
  POST('/plans/:id/goals', act(async (req, res, p, body, user) => {
    svc.addGoal(db, user, Number(p.id), { title: body.title, detail: body.detail, targetDate: body.target_date });
    ok(res, `/plans/${p.id}`, '目标已添加');
  }));
  POST('/goals/:id/status', act(async (req, res, p, body, user) => {
    svc.setGoalStatus(db, user, Number(p.id), body.status);
    ok(res, new URL(req.headers.referer || '/', 'http://local').pathname, '目标状态已更新');
  }));
  POST('/plans/:id/sessions', act(async (req, res, p, body, user) => {
    svc.scheduleSession(db, user, Number(p.id), {
      goalId: body.goal_id ? Number(body.goal_id) : null,
      scheduledAt: body.scheduled_at,
      durationMin: Number(body.duration_min),
    });
    ok(res, `/plans/${p.id}`, '辅导已预约');
  }));
  POST('/sessions/:id/complete', act(async (req, res, p, body, user) => {
    svc.completeSession(db, user, Number(p.id), { summary: body.summary, nextGoals: body.next_goals });
    ok(res, new URL(req.headers.referer || '/', 'http://local').pathname, '纪要已记录');
  }));
  POST('/plans/:id/feedback', act(async (req, res, p, body, user) => {
    svc.addFeedback(db, user, Number(p.id), {
      sessionId: body.session_id ? Number(body.session_id) : null,
      body: body.body,
      claimedAuthorId: body.author_id, // 即使伪造字段也会被拒绝
    });
    ok(res, `/plans/${p.id}`, '私人反馈已提交（仅双方与授权主管可见）');
  }));
  POST('/plans/:id/attachments', act(async (req, res, p, body, user) => {
    const planId = Number(p.id);
    const ctx = svc.planContext(db, planId);
    if (!svc.isParty(user, ctx)) throw new svc.BizError('FORBIDDEN', '仅计划双方可上传附件');
    const safe = String(body.filename || 'attachment.md').replace(/[^\w.一-龥-]+/g, '_').slice(0, 80);
    const stored = `p${planId}_${Date.now()}_${safe}`;
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    fs.writeFileSync(path.join(ATTACH_DIR, stored), String(body.content || ''), 'utf8');
    db.prepare(
      'INSERT INTO attachments (plan_id, filename, stored_name, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?)'
    ).run(planId, safe, stored, Buffer.byteLength(String(body.content || '')), user.id, nowIso());
    ok(res, `/plans/${planId}`, '附件已保存到本地');
  }));
  POST('/plans/:id/change-requests', act(async (req, res, p, body, user) => {
    svc.requestMentorChange(db, user, Number(p.id), {
      reason: body.reason,
      preferredMentorId: body.preferred_mentor_id ? Number(body.preferred_mentor_id) : null,
    });
    ok(res, `/plans/${p.id}`, '换导师申请已提交，等待主管审核');
  }));
  POST('/change-requests/:id/cancel', act(async (req, res, p, body, user) => {
    svc.cancelChangeRequest(db, user, Number(p.id));
    ok(res, '/changes', '申请已撤销');
  }));
  POST('/review/changes/:id/approve', act(async (req, res, p, body, user) => {
    const r = svc.reviewChangeRequest(db, user, Number(p.id), true, {
      note: body.note, newMentorId: body.mentor_id ? Number(body.mentor_id) : null,
    });
    ok(res, '/review', `已换导师，新计划 #${r.newPlanId} 已生成并承接原目标`);
  }));
  POST('/review/changes/:id/reject', act(async (req, res, p, body, user) => {
    svc.reviewChangeRequest(db, user, Number(p.id), false, { note: body.note });
    ok(res, '/review', '换导师申请已驳回');
  }));
  POST('/plans/:id/closure-requests', act(async (req, res, p, body, user) => {
    svc.requestClosure(db, user, Number(p.id), { type: body.type, reason: body.reason });
    ok(res, `/plans/${p.id}`, '结项申请已提交，等待主管审核');
  }));
  POST('/review/closures/:id/approve', act(async (req, res, p, body, user) => {
    svc.reviewClosure(db, user, Number(p.id), true, { note: body.note });
    ok(res, '/review', '结项已通过，名额已释放');
  }));
  POST('/review/closures/:id/reject', act(async (req, res, p, body, user) => {
    svc.reviewClosure(db, user, Number(p.id), false, { note: body.note });
    ok(res, '/review', '结项申请已驳回，计划恢复进行');
  }));
  POST('/profile', act(async (req, res, p, body, user) => {
    svc.updateMentorProfile(db, user, {
      expertise: String(body.expertise || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      monthlyCapacity: Number(body.monthly_capacity),
      bio: body.bio,
      department: body.department,
      slots: parseSlotsField(body.slots).map((s) => ({ weekday: s.weekday, start_min: toMin(s.start), end_min: toMin(s.end) })),
    });
    ok(res, '/profile', '档案已保存');
  }));
  POST('/admin/mentors/:id/depart', act(async (req, res, p, body, user) => {
    const r = svc.markMentorDeparted(db, user, Number(p.id));
    ok(res, '/admin', `导师已标记离职，${r.affected} 个计划已挂起并自动发起换导师`);
  }));
  POST('/admin/scan', act(async (req, res, p, body, user) => {
    if (user.role !== 'admin') throw new svc.BizError('FORBIDDEN', '仅管理员可触发扫描');
    const r = reminders.scan(db);
    ok(res, '/admin', `扫描完成：未开始提醒 ${r.unstarted}，升级 ${r.escalated}，临期提醒 ${r.upcoming}`);
  }));

  // 静态资源
  GET('/static/:file', async (req, res, p) => {
    const file = path.join(PUBLIC_DIR, path.basename(p.file));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    fs.createReadStream(file).pipe(res);
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://local');
    const pathname = u.pathname;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const user = currentUser(req);
      const isPublic = pathname === '/login' || pathname.startsWith('/static/');
      if (!user && !isPublic) return redirect(res, '/login');
      try {
        return await r.handler(req, res, params, u.searchParams, user);
      } catch (e) {
        console.error(e);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('服务器错误');
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('页面不存在');
  });

  return server;
}

module.exports = { createServer };
