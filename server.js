'use strict';
// 一条命令启动：npm start
// 首次启动自动建库、写入演示数据（含换导师案例），并启动进程内提醒任务。

const { openDb, DB_PATH } = require('./src/db');
const { seedIfEmpty } = require('./src/seed');
const { createServer } = require('./src/web');
const reminders = require('./src/reminders');

const PORT = Number(process.env.PORT || 3000);

const db = openDb(DB_PATH);
const seeded = seedIfEmpty(db);

// 启动即扫描一次提醒（长期未开始等），之后进程内每 60 秒扫描
const first = reminders.scan(db);
reminders.startScheduler(db, 60000);

const server = createServer(db);
server.listen(PORT, () => {
  console.log('');
  console.log('  导师制辅导平台已启动');
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  数据库: ${DB_PATH}${seeded ? '（已写入演示数据）' : ''}`);
  console.log(`  提醒扫描: 长期未开始 ${first.unstarted}，升级 ${first.escalated}，临期 ${first.upcoming}`);
  console.log('');
  console.log('  演示入口：打开页面后选择身份一键登录。');
  console.log('  换导师案例：以主管「郑凯」或「冯敏」登录 → 审核台 → 换导师审核。');
  console.log('');
});
