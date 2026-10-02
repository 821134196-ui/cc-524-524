'use strict';
// 私密字段权限：私人反馈仅当事双方与授权主管可见；查看留痕；导师不能替员工提交反馈

const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, addUser, addMentor, apply } = require('./helpers');
const svc = require('../src/services');

function setup() {
  const { db } = tmpDb();
  const sup = addUser(db, '主管', 'supervisor', '市场部');
  const mentor = addMentor(db, '导师', '技术部', 2, ['后端工程']);
  const emp = addUser(db, '员工', 'employee', '产品部');
  const outsider = addUser(db, '路人员工', 'employee', '设计部');
  const otherMentor = addMentor(db, '其他导师', '设计部', 1, ['交互设计']);
  const appId = apply(db, emp, ['后端工程'], null, mentor);
  const { planId } = svc.confirmApplication(db, svc.getUser(db, sup), appId, mentor);
  return { db, sup, mentor, emp, outsider, otherMentor, planId };
}

test('私密权限：双方与主管可见，无关员工/导师不可见', () => {
  const { db, sup, mentor, emp, outsider, otherMentor, planId } = setup();
  svc.addFeedback(db, svc.getUser(db, emp), planId, { body: '员工的私人反馈' });

  // 当事双方 + 授权主管可见
  for (const uid of [emp, mentor, sup]) {
    const rows = svc.viewFeedback(db, svc.getUser(db, uid), planId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].body, '员工的私人反馈');
  }
  // 无关人员被拒绝
  for (const uid of [outsider, otherMentor]) {
    assert.throws(
      () => svc.viewFeedback(db, svc.getUser(db, uid), planId),
      (e) => e.code === 'FORBIDDEN'
    );
  }
});

test('私密权限：查看私人反馈写入访问记录，越权访问不留痕', () => {
  const { db, sup, mentor, emp, outsider, planId } = setup();
  svc.addFeedback(db, svc.getUser(db, mentor), planId, { body: '导师的私人反馈' });

  svc.viewFeedback(db, svc.getUser(db, emp), planId);
  svc.viewFeedback(db, svc.getUser(db, sup), planId);
  assert.throws(() => svc.viewFeedback(db, svc.getUser(db, outsider), planId), /私人反馈/);

  const logs = db.prepare(
    "SELECT * FROM access_logs WHERE action='view_private_feedback' AND object_id=? ORDER BY id"
  ).all(planId);
  assert.strictEqual(logs.length, 2, '只有两次成功查看应留痕');
  assert.deepStrictEqual(logs.map((l) => l.user_id).sort(), [emp, sup].sort());
});

test('私密权限：导师不能替员工提交反馈，作者强制为本人', () => {
  const { db, mentor, emp, planId } = setup();
  const mentorUser = svc.getUser(db, mentor);

  // 伪造 author_id 为他人 → 拒绝
  assert.throws(
    () => svc.addFeedback(db, mentorUser, planId, { body: '冒充员工', claimedAuthorId: emp }),
    (e) => e.code === 'FORBIDDEN' && /代替他人/.test(e.message)
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) c FROM feedback WHERE plan_id=?').get(planId).c, 0,
    '伪造提交不应落库'
  );

  // 正常提交：作者 = 当前登录人
  svc.addFeedback(db, mentorUser, planId, { body: '导师本人反馈' });
  const row = db.prepare('SELECT * FROM feedback WHERE plan_id=?').get(planId);
  assert.strictEqual(row.author_id, mentor);
});

test('私密权限：非计划双方（含主管）不能提交私人反馈', () => {
  const { db, sup, outsider, planId } = setup();
  for (const uid of [sup, outsider]) {
    assert.throws(
      () => svc.addFeedback(db, svc.getUser(db, uid), planId, { body: 'x' }),
      (e) => e.code === 'FORBIDDEN'
    );
  }
});
