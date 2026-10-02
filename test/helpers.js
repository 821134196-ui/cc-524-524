'use strict';
// 测试公共工具：临时库 + 快速造数

const os = require('os');
const path = require('path');
const fs = require('fs');
const { openDb } = require('../src/db');
const svc = require('../src/services');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-test-'));
  process.env.MENTOR_OUTBOX = path.join(dir, 'outbox.log');
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  return { db, dir, dbPath };
}

function addUser(db, name, role, department) {
  const r = db.prepare(
    "INSERT INTO users (name, role, department, active, created_at) VALUES (?,?,?,1,'2026-01-01T09:00')"
  ).run(name, role, department);
  return Number(r.lastInsertRowid);
}

function addMentor(db, name, department, capacity, expertise, slots) {
  const id = addUser(db, name, 'mentor', department);
  db.prepare(
    'INSERT INTO mentor_profiles (user_id, expertise, monthly_capacity, bio, active) VALUES (?,?,?,?,1)'
  ).run(id, JSON.stringify(expertise || ['通用']), capacity, '');
  for (const s of slots || [{ weekday: 2, start: '19:00', end: '21:00' }]) {
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    db.prepare('INSERT INTO mentor_slots (mentor_id, weekday, start_min, end_min) VALUES (?,?,?,?)')
      .run(id, s.weekday, sh * 60 + sm, eh * 60 + em);
  }
  return id;
}

function user(db, id) { return svc.getUser(db, id); }

// 员工提交申请（返回申请 id）
function apply(db, employeeId, skills, slots, mentorId) {
  return svc.createApplication(db, user(db, employeeId), {
    skills: skills || ['产品规划'],
    slots: slots || [{ weekday: 2, start: '19:00', end: '20:00' }],
    note: '',
    preferredMentorId: mentorId || null,
  }).id;
}

// 主管确认 → { matchId, planId }
function confirm(db, supervisorId, appId, mentorId) {
  return svc.confirmApplication(db, user(db, supervisorId), appId, mentorId);
}

module.exports = { tmpDb, addUser, addMentor, user, apply, confirm };
