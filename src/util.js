'use strict';
// 通用小工具：HTML 转义、时间、时段、JSON、HTTP 辅助

const WEEKDAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

// 本地时间 ISO（到分钟），用于 SQLite 文本比较
function isoLocal(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function nowIso() { return isoLocal(new Date()); }
function today() { return isoLocal(new Date()).slice(0, 10); }
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoLocal(d);
}
function addMinutesIso(iso, minutes) {
  const d = new Date(iso.replace('T', ' ') + ':00');
  d.setMinutes(d.getMinutes() + minutes);
  return isoLocal(d);
}
function fmtDT(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ');
}
function fmtDate(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

// 时段：{weekday:1-7, start:'HH:MM', end:'HH:MM'}；存储用分钟数
function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
function slotLabel(s) {
  return `${WEEKDAYS[s.weekday] || '?'} ${s.start || toHHMM(s.start_min)}–${s.end || toHHMM(s.end_min)}`;
}
function slotsOverlap(a, b) {
  if (a.weekday !== b.weekday) return false;
  const a0 = a.start_min != null ? a.start_min : toMin(a.start);
  const a1 = a.end_min != null ? a.end_min : toMin(a.end);
  const b0 = b.start_min != null ? b.start_min : toMin(b.start);
  const b1 = b.end_min != null ? b.end_min : toMin(b.end);
  return a0 < b1 && b0 < a1;
}
function anyOverlap(listA, listB) {
  for (const a of listA) for (const b of listB) if (slotsOverlap(a, b)) return true;
  return false;
}

function jparse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---- HTTP 辅助 ----
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      } else {
        const p = new URLSearchParams(data);
        const obj = {};
        for (const [k, v] of p) {
          if (obj[k] === undefined) obj[k] = v;
          else if (Array.isArray(obj[k])) obj[k].push(v);
          else obj[k] = [obj[k], v];
        }
        resolve(obj);
      }
    });
    req.on('error', reject);
  });
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

module.exports = {
  WEEKDAYS, esc, isoLocal, nowIso, today, daysAgoIso, addMinutesIso,
  fmtDT, fmtDate, toMin, toHHMM, slotLabel, slotsOverlap, anyOverlap,
  jparse, parseCookies, readBody, asArray, pad,
};
