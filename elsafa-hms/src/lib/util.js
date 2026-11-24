// أدوات عامة: أخطاء، فلوس، وقت القاهرة

import { R } from './runtime.js';
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (msg = 'مش موجود') => new HttpError(404, msg);
export const forbidden = (msg = 'مش مسموح لك بالعملية دي') => new HttpError(403, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);

// ---------- الفلوس: كل الحسابات في الكود بالقروش (أعداد صحيحة) ----------
// الحساب نفسه في shared/money.js، بيتظبط بإعدادات العملة (R.money). مع خانتين (الافتراضي) نفس التعبيرات القديمة بالظبط.
/** من قيمة القاعدة (وحدات العملة) للوحدة الصغرى (قرش) */
export const cents = (v) => R.money.toMinor(v);
/** من الوحدة الصغرى لقيمة القاعدة */
export const pounds = (c) => R.money.fromMinor(c);
/** من إدخال المستخدم للوحدة الصغرى مع التحقق */
export function parseMoney(v, label = 'المبلغ') {
  return R.money.parse(v, label, bad);
}

// ---------- وقت القاهرة ----------
function parts(d) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: R.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const o = {};
  for (const x of p) o[x.type] = x.value;
  return o;
}
/** فرق توقيت القاهرة عن UTC بالدقائق في لحظة معينة (بيتغير مع التوقيت الصيفي) */
function offsetMin(d) {
  const o = parts(d);
  const asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}
/** تاريخ اليوم في القاهرة YYYY-MM-DD */
export function cairoDate(d = new Date()) {
  const o = parts(d);
  return `${o.year}-${o.month}-${o.day}`;
}
/** بداية ونهاية يوم القاهرة كتواريخ UTC */
export function cairoDayRange(dateStr = cairoDate()) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, dd, 0, 0, 0));
  const start = new Date(guess.getTime() - offsetMin(guess) * 60000);
  const guess2 = new Date(Date.UTC(y, m - 1, dd + 1, 0, 0, 0));
  const end = new Date(guess2.getTime() - offsetMin(guess2) * 60000);
  return { start, end };
}
/** اليوم في الأسبوع: 0=السبت ... 6=الجمعة */
export function cairoWeekday(d = new Date()) {
  return { Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6 }[parts(d).weekday];
}
/** الدقيقة الحالية في يوم القاهرة */
export function cairoMinutes(d = new Date()) {
  const o = parts(d);
  return (+o.hour % 24) * 60 + +o.minute;
}
export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? +m[1] * 60 + +m[2] : null;
}

export function str(v, max = 500) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
export function intId(v, label = 'الرقم') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${label} مش صحيح`);
  return n;
}
