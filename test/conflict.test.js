'use strict'
// 时间冲突流转：申请时段与导师可带时段无交集 → 申请标记冲突并通知；
// 辅导次预约与既有安排重叠 → 拒绝

const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, addUser, addMentor, apply } = require('./helpers');
const svc = require('../src/services');

test('冲突：申请时段与导师时段无交集，申请被标记为冲突', () => {
  const { db } = tmpDb();
  const sup = addUser(db, '主管', 'supervisor', '市场部');
  // 导师仅周二晚可带
  const mentor = addMentor(db, '导师', '技术部', 2, ['前端架构'],
    [{ weekday: 2, start: '19:00', end: '21:00' }]);
  const emp = addUser(db, '员工', 'employee', '产品部');
  // 员工仅周五晚可交流
  const appId = apply(db, emp, ['前端架构'], [{ weekday: 5, start: '19:00', end: '20:00' }], mentor);

  assert.throws(
    () => svc.confirmApplication(db, svc.getUser(db, sup), appId, mentor),
    (e) => e.code === 'CONFLICT'
  );
  const app = svc.getApplication(db, appId);
  assert.strictEqual(app.status, 'conflict');
  assert.ok(/无交集/.test(app.review_note));
  // 员工收到通知
  const msg = db.prepare(
    "SELECT * FROM messages WHERE user_id=? AND kind='conflict'"
  ).get(emp);
  assert.ok(msg, '员工应收到时段冲突通知');
});

test('冲突：导师同一时间段不可重复安排辅导', () => {
  const { db } = tmpDb();
  const sup = addUser(db, '主管', 'supervisor', '市场部');
  const mentor = addMentor(db, '导师', '技术部', 2, ['后端工程']);
  const e1 = addUser(db, '员工一', 'employee', '产品部');
  const e2 = addUser(db, '员工二', 'employee', '设计部');
  const a1 = apply(db, e1, ['后端工程'], null, mentor);
  const p1 = svc.confirmApplication(db, svc.getUser(db, sup), a1, mentor).planId;
  const a2 = apply(db, e2, ['后端工程'], null, mentor);
  const p2 = svc.confirmApplication(db, svc.getUser(db, sup), a2, mentor).planId;

  const mentorUser = svc.getUser(db, mentor);
  svc.scheduleSession(db, mentorUser, p1, { scheduledAt: '2026-10-06T19:00', durationMin: 60 });
  // 与已有安排重叠 → 拒绝
  assert.throws(
    () => svc.scheduleSession(db, mentorUser, p2, { scheduledAt: '2026-10-06T19:30', durationMin: 60 }),
    (e) => e.code === 'CONFLICT'
  );
  // 不重叠 → 通过
  const r = svc.scheduleSession(db, mentorUser, p2, { scheduledAt: '2026-10-06T20:30', durationMin: 60 });
  assert.ok(r.id > 0);
});
