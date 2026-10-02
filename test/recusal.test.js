'use strict';
// 跨部门回避：与员工或导师同部门的主管必须回避；无关联主管与管理员可处理

const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, addUser, addMentor, apply } = require('./helpers');
const svc = require('../src/services');

function setup() {
  const t = tmpDb();
  const { db } = t;
  const mentor = addMentor(db, '导师', '技术部', 2, ['前端架构']);
  const emp = addUser(db, '员工', 'employee', '产品部');
  const supSameEmp = addUser(db, '主管-同员工部门', 'supervisor', '产品部');
  const supSameMentor = addUser(db, '主管-同导师部门', 'supervisor', '技术部');
  const supOther = addUser(db, '主管-无关联', 'supervisor', '市场部');
  const admin = addUser(db, '管理员', 'admin', '产品部'); // 与员工同部门的管理员
  const appId = apply(db, emp, ['前端架构'], null, mentor);
  return { ...t, mentor, emp, supSameEmp, supSameMentor, supOther, admin, appId };
}

test('回避：与员工同部门的主管确认配对被拒绝', () => {
  const { db, supSameEmp, appId, mentor } = setup();
  assert.throws(
    () => svc.confirmApplication(db, svc.getUser(db, supSameEmp), appId, mentor),
    (e) => e.code === 'RECUSAL' && /回避/.test(e.message)
  );
  // 申请仍未被处理
  assert.strictEqual(svc.getApplication(db, appId).status, 'pending');
});

test('回避：与导师同部门的主管确认配对被拒绝', () => {
  const { db, supSameMentor, appId, mentor } = setup();
  assert.throws(
    () => svc.confirmApplication(db, svc.getUser(db, supSameMentor), appId, mentor),
    (e) => e.code === 'RECUSAL'
  );
});

test('回避：无关联部门主管可确认；同部门管理员不受回避限制', () => {
  const { db, supOther, admin, appId, mentor } = setup();
  // 无关联主管确认成功
  const r = svc.confirmApplication(db, svc.getUser(db, supOther), appId, mentor);
  assert.ok(r.planId > 0);

  // 管理员即使与员工同部门也可操作（另造一单）
  const emp2 = addUser(db, '员工二', 'employee', '产品部');
  const app2 = apply(db, emp2, ['前端架构'], null, mentor);
  const r2 = svc.confirmApplication(db, svc.getUser(db, admin), app2, mentor);
  assert.ok(r2.planId > 0);
});

test('回避：换导师审核同样适用（与任一方同部门均需回避）', () => {
  const { db, supOther, appId, mentor, emp } = setup();
  const { planId } = svc.confirmApplication(db, svc.getUser(db, supOther), appId, mentor);
  const newMentor = addMentor(db, '新导师', '设计部', 1, ['交互设计'],
    [{ weekday: 2, start: '19:00', end: '21:00' }]);
  const reqId = svc.requestMentorChange(db, svc.getUser(db, emp), planId, {
    reason: '方向调整', preferredMentorId: newMentor,
  }).id;

  const supEmpDept = addUser(db, '主管-产品', 'supervisor', '产品部');   // 同员工
  const supOldDept = addUser(db, '主管-技术', 'supervisor', '技术部');   // 同原导师
  const supNewDept = addUser(db, '主管-设计', 'supervisor', '设计部');   // 同新导师
  const supFree = addUser(db, '主管-市场', 'supervisor', '市场部');      // 无关联

  for (const sid of [supEmpDept, supOldDept, supNewDept]) {
    assert.throws(
      () => svc.reviewChangeRequest(db, svc.getUser(db, sid), reqId, true, {}),
      (e) => e.code === 'RECUSAL',
      `主管 ${sid} 应被要求回避`
    );
  }
  const r = svc.reviewChangeRequest(db, svc.getUser(db, supFree), reqId, true, {});
  assert.strictEqual(r.approved, true);
  assert.ok(r.newPlanId > 0);
});
