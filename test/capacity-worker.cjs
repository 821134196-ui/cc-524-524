'use strict';
// 容量竞争 worker：独立连接参与并发确认，模拟两个主管同时操作

const { parentPort, workerData } = require('worker_threads');
const { openDb } = require('../src/db');
const svc = require('../src/services');

const db = openDb(workerData.dbPath);
try {
  const r = svc.confirmApplication(
    db,
    svc.getUser(db, workerData.supervisorId),
    workerData.applicationId,
    workerData.mentorId
  );
  parentPort.postMessage({ ok: true, planId: r.planId });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e.code || 'ERROR', message: e.message });
}
