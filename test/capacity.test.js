'use strict';
// 容量竞争：两个主管并发确认同一导师的最后一个名额，必须且只能成功一个

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Worker } = require('worker_threads');
const { tmpDb, addUser, addMentor, apply } = require('./helpers');
const svc = require('../src/services');

function runWorker(dbPath, supervisorId, applicationId, mentorId) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'capacity-worker.cjs'), {
      workerData: { dbPath, supervisorId, applicationId, mentorId },
    });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

test('容量竞争：并发确认同一导师最后名额，仅一人成功，名额不超占', async () => {
  const { db, dbPath } = tmpDb();
  const sup1 = addUser(db, '主管甲', 'supervisor', '市场部');
  const sup2 = addUser(db, '主管乙', 'supervisor', '设计部');
  const mentor = addMentor(db, '导师A', '技术部', 1, ['后端工程']); // 容量仅 1
  const e1 = addUser(db, '员工一', 'employee', '产品部');
  const e2 = addUser(db, '员工二', 'employee', '产品部');
  const app1 = apply(db, e1, ['后端工程'], [{ weekday: 2, start: '19:00', end: '20:00' }], mentor);
  const app2 = apply(db, e2, ['后端工程'], [{ weekday: 2, start: '19:30', end: '20:30' }], mentor);

  // 两个主管真正并发（各自独立连接，BEGIN IMMEDIATE 串行化临界区）
  const [r1, r2] = await Promise.all([
    runWorker(dbPath, sup1, app1, mentor),
    runWorker(dbPath, sup2, app2, mentor),
  ]);

  const results = [r1, r2];
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  assert.strictEqual(succeeded.length, 1, `应恰好一个成功，实际: ${JSON.stringify(results)}`);
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].code, 'CAPACITY_FULL', `失败原因应为名额已满: ${JSON.stringify(failed[0])}`);

  // 最终状态：导师进行中计划数 == 容量，未超占
  assert.strictEqual(svc.activeMatchCount(db, mentor), 1);
  assert.strictEqual(svc.remainingCapacity(db, mentor), 0);
  const plans = db.prepare("SELECT COUNT(*) c FROM plans WHERE status='active'").get().c;
  assert.strictEqual(plans, 1);
});

test('容量竞争：名额占满后再次确认被拒绝', () => {
  const { db } = tmpDb();
  const sup = addUser(db, '主管', 'supervisor', '市场部');
  const mentor = addMentor(db, '导师B', '技术部', 1, ['前端架构']);
  const e1 = addUser(db, '员工甲', 'employee', '产品部');
  const e2 = addUser(db, '员工乙', 'employee', '设计部');
  const app1 = apply(db, e1, ['前端架构'], null, mentor);
  const app2 = apply(db, e2, ['前端架构'], null, mentor);

  const r = svc.confirmApplication(db, svc.getUser(db, sup), app1, mentor);
  assert.ok(r.planId > 0);
  assert.throws(
    () => svc.confirmApplication(db, svc.getUser(db, sup), app2, mentor),
    (e) => e.code === 'CAPACITY_FULL'
  );
  assert.strictEqual(svc.activeMatchCount(db, mentor), 1);
});
