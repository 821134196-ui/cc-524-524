'use strict';
// 计划结项：提前完成申请 → 主管审核（回避适用）→ 计划关闭、配对结束、名额释放

const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, addUser, addMentor, apply } = require('./helpers');
const svc = require('../src/services');

function setup() {
  const { db } = tmpDb();
  const sup = addUser(db, '主管-市场', 'supervisor', '市场部');
  const supRecused = addUser(db, '主管-技术', 'supervisor', '技术部'); // 与导师同部门
  const mentor = addMentor(db, '导师', '技术部', 1, ['DevOps']);
  const emp = addUser(db, '员工', 'employee', '产品部');
  const appId = apply(db, emp, ['DevOps'], null, mentor);
  const { planId } = svc.confirmApplication(db, svc.getUser(db, sup), appId, mentor);
  return { db, sup, supRecused, mentor, emp, planId };
}

test('结项：提前完成全流程，名额释放，状态正确', () => {
  const { db, sup, mentor, emp, planId } = setup();
  assert.strictEqual(svc.activeMatchCount(db, mentor), 1);

  // 员工申请提前完成
  const reqId = svc.requestClosure(db, svc.getUser(db, emp), planId, {
    type: 'early', reason: '目标已提前达成',
  }).id;
  assert.strictEqual(svc.getPlan(db, planId).status, 'closing');

  // 重复申请被拒
  assert.throws(
    () => svc.requestClosure(db, svc.getUser(db, emp), planId, { type: 'early', reason: 'x' }),
    (e) => e.code === 'STATUS'
  );

  // 主管通过
  const r = svc.reviewClosure(db, svc.getUser(db, sup), reqId, true, { note: '同意' });
  assert.strictEqual(r.approved, true);

  const plan = svc.getPlan(db, planId);
  assert.strictEqual(plan.status, 'closed');
  assert.strictEqual(plan.close_type, 'early');
  assert.ok(plan.closed_at);

  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(plan.match_id);
  assert.strictEqual(match.status, 'ended');
  assert.strictEqual(match.end_reason, 'early_completed');

  // 名额释放
  assert.strictEqual(svc.activeMatchCount(db, mentor), 0);
  assert.strictEqual(svc.remainingCapacity(db, mentor), 1);

  // 双方收到回执消息
  const msgs = db.prepare("SELECT COUNT(*) c FROM messages WHERE kind='closure_approved'").get().c;
  assert.strictEqual(msgs, 2);
});

test('结项：同部门主管审核被要求回避', () => {
  const { db, supRecused, emp, planId } = setup();
  const reqId = svc.requestClosure(db, svc.getUser(db, emp), planId, {
    type: 'completed', reason: '到期结项',
  }).id;
  assert.throws(
    () => svc.reviewClosure(db, svc.getUser(db, supRecused), reqId, true, {}),
    (e) => e.code === 'RECUSAL'
  );
  // 申请仍待审核，计划仍在结项审核中
  assert.strictEqual(
    db.prepare('SELECT status FROM closure_requests WHERE id=?').get(reqId).status, 'pending'
  );
  assert.strictEqual(svc.getPlan(db, planId).status, 'closing');
});

test('结项：驳回后计划恢复进行，且不可重复审核', () => {
  const { db, sup, emp, planId } = setup();
  const reqId = svc.requestClosure(db, svc.getUser(db, emp), planId, {
    type: 'early', reason: '提前完成',
  }).id;
  svc.reviewClosure(db, svc.getUser(db, sup), reqId, false, { note: '目标未全部达成' });
  assert.strictEqual(svc.getPlan(db, planId).status, 'active');
  assert.throws(
    () => svc.reviewClosure(db, svc.getUser(db, sup), reqId, true, {}),
    (e) => e.code === 'STATUS'
  );
});
