'use strict';
// 演示数据：首次启动时写入。
// 内置案例：
//   换导师   —— 陈晓（产品部）× 周岩（技术部）计划进行中，陈晓已申请换到林岚，待主管审核
//   提前完成 —— 李萌 × 孙洁 计划目标提前达成，结项申请待审核
//   长期未开始 —— 王浩 × 赵启 确认 20 天仍无辅导次，启动时提醒任务会自动预警
//   回避演示 —— 吴倩（产品部主管）审核陈晓相关事项会被系统要求回避
//   容量演示 —— 林岚容量 1，赵欣的待确认申请与陈晓的换导师申请都指向她

const fs = require('fs');
const path = require('path');
const { nowIso, daysAgoIso, isoLocal, toMin } = require('./util');

const ATTACH_DIR = process.env.MENTOR_ATTACH_DIR || path.join(__dirname, '..', 'attachments');

function seedIfEmpty(db) {
  const c = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (c > 0) return false;
  seed(db);
  return true;
}

function seed(db) {
  const now = nowIso();
  const inUser = db.prepare(
    'INSERT INTO users (name, role, department, active, created_at) VALUES (?,?,?,1,?)'
  );
  const uid = (name, role, dept) => Number(inUser.run(name, role, dept, now).lastInsertRowid);

  // ---- 用户 ----
  const admin = uid('系统管理员', 'admin', '运营部');
  const supQian = uid('钱进', 'supervisor', '技术部');
  const supWu = uid('吴倩', 'supervisor', '产品部');
  const supZheng = uid('郑凯', 'supervisor', '市场部');
  const supFeng = uid('冯敏', 'supervisor', '设计部');

  const mZhou = uid('周岩', 'mentor', '技术部');
  const mLin = uid('林岚', 'mentor', '产品部');
  const mZhao = uid('赵启', 'mentor', '设计部');
  const mSun = uid('孙洁', 'mentor', '技术部');

  const eChen = uid('陈晓', 'employee', '产品部');
  const eLi = uid('李萌', 'employee', '技术部');
  const eWang = uid('王浩', 'employee', '市场部');
  const eZhao = uid('赵欣', 'employee', '市场部');

  // ---- 导师档案 ----
  const inProfile = db.prepare(
    'INSERT INTO mentor_profiles (user_id, expertise, monthly_capacity, bio, active) VALUES (?,?,?,?,1)'
  );
  inProfile.run(mZhou, JSON.stringify(['前端架构', '性能优化']), 2, '十年前端，专注大型应用架构与性能治理。');
  inProfile.run(mLin, JSON.stringify(['产品规划', '数据分析']), 1, '产品总监，擅长从 0 到 1 规划与数据驱动决策。');
  inProfile.run(mZhao, JSON.stringify(['交互设计', '用户研究']), 2, '设计专家，主导多条产品线交互规范。');
  inProfile.run(mSun, JSON.stringify(['后端工程', 'DevOps']), 1, '后端架构师，热衷稳定性与效能提升。');

  const inSlot = db.prepare(
    'INSERT INTO mentor_slots (mentor_id, weekday, start_min, end_min) VALUES (?,?,?,?)'
  );
  const slot = (m, wd, s, e) => inSlot.run(m, wd, toMin(s), toMin(e));
  slot(mZhou, 2, '19:00', '21:00'); slot(mZhou, 4, '19:00', '21:00');
  slot(mLin, 1, '19:00', '20:30'); slot(mLin, 3, '19:00', '20:30');
  slot(mZhao, 5, '18:00', '20:00'); slot(mZhao, 6, '10:00', '12:00');
  slot(mSun, 2, '20:00', '22:00'); slot(mSun, 7, '14:00', '16:00');

  // ---- 历史申请（已配对） ----
  const inApp = db.prepare(
    `INSERT INTO applications (employee_id, skills, slots, note, preferred_mentor_id, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const app = (emp, skills, slots, note, mentor, status, at) => Number(
    inApp.run(emp, JSON.stringify(skills), JSON.stringify(slots), note, mentor, status, at, at).lastInsertRowid
  );
  const a1 = app(eChen, ['前端架构', '性能优化'],
    [{ weekday: 2, start: '19:00', end: '20:00' }, { weekday: 1, start: '19:00', end: '20:00' }],
    '希望系统提升前端能力，为转岗做准备。', mZhou, 'matched', daysAgoIso(32));
  const a2 = app(eLi, ['后端工程', 'DevOps'],
    [{ weekday: 2, start: '20:00', end: '21:00' }, { weekday: 7, start: '14:00', end: '15:00' }],
    '想补齐工程效能方向。', mSun, 'matched', daysAgoIso(41));
  const a3 = app(eWang, ['交互设计'],
    [{ weekday: 5, start: '18:00', end: '19:00' }],
    '市场转交互，希望系统学习。', mZhao, 'matched', daysAgoIso(21));

  // ---- 配对 + 计划 ----
  const inMatch = db.prepare(
    `INSERT INTO matches (application_id, mentor_id, employee_id, supervisor_id, status, created_at, confirmed_at)
     VALUES (?,?,?,?,'active',?,?)`
  );
  const inPlan = db.prepare(
    "INSERT INTO plans (match_id, title, status, created_at, started_at) VALUES (?,?,'active',?,?)"
  );
  const m1 = Number(inMatch.run(a1, mZhou, eChen, supFeng, daysAgoIso(30), daysAgoIso(30)).lastInsertRowid);
  const p1 = Number(inPlan.run(m1, '陈晓 × 周岩 辅导计划', daysAgoIso(30), daysAgoIso(21)).lastInsertRowid);
  const m2 = Number(inMatch.run(a2, mSun, eLi, supZheng, daysAgoIso(40), daysAgoIso(40)).lastInsertRowid);
  const p2 = Number(inPlan.run(m2, '李萌 × 孙洁 辅导计划', daysAgoIso(40), daysAgoIso(35)).lastInsertRowid);
  const m3 = Number(inMatch.run(a3, mZhao, eWang, supQian, daysAgoIso(20), daysAgoIso(20)).lastInsertRowid);
  const p3 = Number(inPlan.run(m3, '王浩 × 赵启 辅导计划', daysAgoIso(20), null).lastInsertRowid);

  // ---- 目标 ----
  const inGoal = db.prepare(
    'INSERT INTO goals (plan_id, seq, title, detail, status, target_date, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const future = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoLocal(d).slice(0, 10); };
  const g1 = Number(inGoal.run(p1, 1, '前端架构入门', '组件化、状态管理与工程化基础', 'done', daysAgoIso(8).slice(0, 10), daysAgoIso(30)).lastInsertRowid);
  const g2 = Number(inGoal.run(p1, 2, '性能优化实践', '首屏指标、加载策略与监控', 'open', future(14), daysAgoIso(30)).lastInsertRowid);
  const g3 = Number(inGoal.run(p2, 1, '后端服务设计', '边界划分、接口契约与容量评估', 'done', daysAgoIso(20).slice(0, 10), daysAgoIso(40)).lastInsertRowid);
  const g4 = Number(inGoal.run(p2, 2, 'CI/CD 流水线搭建', '从提交到发布的自动化', 'done', daysAgoIso(10).slice(0, 10), daysAgoIso(40)).lastInsertRowid);
  const g5 = Number(inGoal.run(p2, 3, '线上稳定性运营', '告警、值班与复盘机制', 'open', future(7), daysAgoIso(40)).lastInsertRowid);
  inGoal.run(p3, 1, '交互设计基础', '信息架构与交互原则', 'open', future(30), daysAgoIso(20));

  // ---- 辅导次（纪要） ----
  const inSession = db.prepare(
    `INSERT INTO sessions (plan_id, goal_id, seq, scheduled_at, duration_min, held_at, summary, next_goals, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const s1 = Number(inSession.run(p1, g1, 1, daysAgoIso(21), 60, daysAgoIso(21),
    '梳理了组件化拆分原则，对照现有项目指出三处可改进点；演示了状态管理选型思路。',
    '完成一个页面的组件化重构练习', mZhou, daysAgoIso(21)).lastInsertRowid);
  const s2 = Number(inSession.run(p1, g2, 2, daysAgoIso(7), 60, daysAgoIso(7),
    '讲解了首屏性能指标体系（LCP/INP），用真实项目演示了懒加载与预加载策略。',
    '在练习项目接入性能监控并输出报告', mZhou, daysAgoIso(7)).lastInsertRowid);
  const s3 = Number(inSession.run(p2, g3, 1, daysAgoIso(35), 60, daysAgoIso(35),
    '讨论了服务边界划分方法，评审了李萌负责的订单服务重构方案。', '补充接口契约文档', mSun, daysAgoIso(35)).lastInsertRowid);
  const s4 = Number(inSession.run(p2, g4, 2, daysAgoIso(28), 90, daysAgoIso(28),
    '搭建了流水线骨架：构建、单测、镜像、部署四阶段；约定了质量门禁。', '补齐回滚与灰度策略', mSun, daysAgoIso(28)).lastInsertRowid);
  const s5 = Number(inSession.run(p2, g4, 3, daysAgoIso(14), 60, daysAgoIso(14),
    '流水线全链路跑通，讨论了告警分级与值班表设计。', '整理稳定性运营手册初稿', mSun, daysAgoIso(14)).lastInsertRowid);

  // ---- 私人反馈（仅双方与授权主管可见） ----
  const inFb = db.prepare(
    'INSERT INTO feedback (plan_id, session_id, author_id, body, created_at) VALUES (?,?,?,?,?)'
  );
  inFb.run(p1, s1, mZhou, '陈晓基础不错，组件化理解很快；建议多动手，少看理论。', daysAgoIso(21));
  inFb.run(p1, s1, eChen, '周老师讲得很细，但节奏有点快，希望下次多留些提问时间。', daysAgoIso(21));
  inFb.run(p1, s2, eChen, '性能部分很实用，已经开始在项目里试用了。', daysAgoIso(7));
  inFb.run(p2, s3, mSun, '李萌对服务拆分的理解超出预期，可以加快进度。', daysAgoIso(35));
  inFb.run(p2, s5, eLi, '三次辅导收获很大，目标基本达成，考虑申请提前结项。', daysAgoIso(14));

  // ---- 换导师案例（演示主线）：陈晓 申请 周岩 → 林岚 ----
  db.prepare(
    `INSERT INTO change_requests (plan_id, employee_id, old_mentor_id, preferred_mentor_id, reason, status, created_at)
     VALUES (?,?,?,?,?,'pending',?)`
  ).run(p1, eChen, mZhou, mLin,
    '职业方向调整为产品经理，希望转向产品规划与数据分析方向，申请更换导师为林岚。',
    daysAgoIso(2));

  // ---- 提前完成案例：李萌 × 孙洁 ----
  db.prepare(
    `INSERT INTO closure_requests (plan_id, requested_by, type, reason, status, created_at)
     VALUES (?,?,'early',?,'pending',?)`
  ).run(p2, eLi, '三个目标中两个已达成，剩余内容已在工作中覆盖，申请提前完成结项。', daysAgoIso(1));
  db.prepare("UPDATE plans SET status='closing' WHERE id=?").run(p2);

  // ---- 待确认申请：赵欣 → 林岚（容量演示：林岚容量 1） ----
  app(eZhao, ['产品规划', '数据分析'],
    [{ weekday: 1, start: '19:00', end: '20:00' }, { weekday: 3, start: '19:00', end: '20:00' }],
    '希望转型产品方向。', mLin, 'pending', daysAgoIso(1));

  // ---- 消息回执（模拟适配器历史记录） ----
  const inMsg = db.prepare(
    "INSERT INTO messages (user_id, kind, title, body, status, created_at) VALUES (?,?,?,?,'delivered',?)"
  );
  inMsg.run(eChen, 'matched', '配对成功', '主管 冯敏 已确认您与导师 周岩 的配对。', daysAgoIso(30));
  inMsg.run(mZhou, 'matched', '新的辅导计划', '员工 陈晓 已配对给您。', daysAgoIso(30));
  inMsg.run(eLi, 'matched', '配对成功', '主管 郑凯 已确认您与导师 孙洁 的配对。', daysAgoIso(40));
  inMsg.run(eWang, 'matched', '配对成功', '主管 钱进 已确认您与导师 赵启 的配对。', daysAgoIso(20));
  inMsg.run(mZhou, 'change_requested', '员工申请换导师',
    '员工 陈晓 就计划 #' + p1 + ' 提交了换导师申请，等待主管审核。', daysAgoIso(2));

  // ---- 虚构附件（本地文件） ----
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const inAtt = db.prepare(
    'INSERT INTO attachments (plan_id, filename, stored_name, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?)'
  );
  const putFile = (planId, filename, stored, content, uploader, at) => {
    const p = path.join(ATTACH_DIR, stored);
    fs.writeFileSync(p, content, 'utf8');
    inAtt.run(planId, filename, stored, Buffer.byteLength(content), uploader, at);
  };
  putFile(p1, '陈晓-前端学习笔记.md', 'seed_p1_notes.md',
    '# 前端学习笔记（虚构附件）\n\n- 组件化：单一职责、 props 下行 / 事件上行\n- 性能：LCP < 2.5s，图片懒加载\n- 下一步：接入监控并输出报告\n', eChen, daysAgoIso(7));
  putFile(p2, '李萌-DevOps清单.md', 'seed_p2_checklist.md',
    '# DevOps 落地清单（虚构附件）\n\n1. 构建：缓存依赖，并行任务\n2. 测试：单测门禁 80%\n3. 部署：灰度 5% → 50% → 100%\n4. 回滚：一键回退上一版本\n', eLi, daysAgoIso(14));

  // ---- 访问记录样例 ----
  const inLog = db.prepare(
    'INSERT INTO access_logs (user_id, action, object_type, object_id, detail, created_at) VALUES (?,?,?,?,?,?)'
  );
  inLog.run(supFeng, 'confirm_match', 'match', m1, '确认配对：员工 陈晓 × 导师 周岩', daysAgoIso(30));
  inLog.run(supZheng, 'confirm_match', 'match', m2, '确认配对：员工 李萌 × 导师 孙洁', daysAgoIso(40));

  return { p1, p2, p3 };
}

module.exports = { seedIfEmpty, seed };
