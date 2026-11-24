// الربط مع منشأة تانية: إعدادات الاتصال، النداء الخارجي، وطابور التعديلات
import { randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { encrypt, decrypt } from './secrets.js';
import { toDateStr, toIso } from '../db/index.js';

const K = { enabled: 'peerEnabled', name: 'peerName', url: 'peerUrl', key: 'peerKey', requirePaid: 'peerRequirePaid', publicUrl: 'peerPublicUrl' };

export async function peerCfg(db) {
  const rows = await db.query("SELECT [Key] AS K, Value FROM AppSettings WHERE [Key] LIKE 'peer%'");
  const m = Object.fromEntries(rows.map((r) => [r.K, r.Value]));
  let key = null;
  try { key = decrypt(m[K.key]); } catch { key = null; }
  return { enabled: m[K.enabled] === 'on', name: m[K.name] || 'المنشأة التانية', url: (m[K.url] || '').replace(/\/+$/, ''), key, hasKey: !!key, publicUrl: (m[K.publicUrl] || '').replace(/\/+$/, ''), requirePaid: m[K.requirePaid] !== 'off' };
}

export async function setPeer(db, user, patch) {
  for (const [k, v] of Object.entries(patch)) {
    const key = K[k];
    const val = k === 'key' ? (v ? encrypt(v) : '') : String(v ?? '');
    const ex = await db.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [key]);
    if (ex) await db.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = ?', [val, new Date(), user.id, key]);
    else await db.insert('AppSettings', { '[Key]': key, Value: val, UpdatedAt: new Date(), UpdatedBy: user.id });
  }
}

/** نداء للمنشأة التانية. بيرجع { ok, status, body } ومبيرميش خطأ لو الاتصال وقع */
export async function peerCall(db, method, path, body, cfgIn) {
  const cfg = cfgIn || await peerCfg(db);
  if (!cfg.enabled || !cfg.url || !cfg.key) return { ok: false, status: 0, error: 'الربط مش متفعّل أو ناقص بيانات' };
  try {
    const r = await fetch(cfg.url + '/peer' + path, {
      method, headers: { 'content-type': 'application/json', 'x-peer-key': cfg.key },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j, error: r.ok ? null : j.error || `رد ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: 'مفيش اتصال بالمنشأة التانية' };
  }
}

export function keyMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** البيانات التعريفية بس (الملف الطبي والحسابات والتعاقد ما بيتشاركوش) */
export function identityOf(r) {
  return {
    id: r.Id, no: r.PatientNo, globalId: r.GlobalId || null, name: r.FullName, phone: r.Phone, birthDate: toDateStr(r.BirthDate), ageYears: r.AgeYears,
    sex: r.Sex, nationalId: r.NationalId, address: r.Address, emergencyName: r.EmergencyName, emergencyPhone: r.EmergencyPhone,
    updatedAt: toIso(r.UpdatedAt || r.CreatedAt),
  };
}
export const newGlobalId = () => randomUUID();

/** تعديل ملف مربوط: بيتحط في الطابور (آخر تعديل بس لكل مريض) */
export async function enqueueUpdate(t, patientRow) {
  if (!patientRow?.GlobalId) return;
  await t.run('UPDATE PeerOutbox SET DoneAt = ?, LastError = ? WHERE GlobalId = ? AND Op = ? AND DoneAt IS NULL', [new Date(), 'اتحلّ بتعديل أحدث', patientRow.GlobalId, 'update']);
  await t.insert('PeerOutbox', { GlobalId: patientRow.GlobalId, Op: 'update', Payload: JSON.stringify(identityOf(patientRow)), CreatedAt: new Date(), Attempts: 0 });
}
export async function enqueueEvent(db, globalId, payload) {
  await db.insert('PeerOutbox', { GlobalId: globalId, Op: 'event', Payload: JSON.stringify(payload), CreatedAt: new Date(), Attempts: 0 });
}
export async function enqueueUnlink(db, globalId) {
  await db.insert('PeerOutbox', { GlobalId: globalId, Op: 'unlink', Payload: '{}', CreatedAt: new Date(), Attempts: 0 });
}

let flushing = false;
/** بيبعت الطابور بالترتيب، وبيقف عند أول فشل (اتصال واقع) */
export async function flushOutbox(db) {
  if (flushing) return { sent: 0, pending: -1 };
  flushing = true;
  let sent = 0;
  try {
    const cfg = await peerCfg(db);
    if (!cfg.enabled) return { sent: 0, pending: 0 };
    const rows = await db.query(db.top('SELECT * FROM PeerOutbox WHERE DoneAt IS NULL ORDER BY Id', 100));
    for (const o of rows) {
      const r = o.Op === 'unlink'
        ? await peerCall(db, 'POST', '/unlink', { globalId: o.GlobalId }, cfg)
        : o.Op === 'event'
          ? await peerCall(db, 'POST', '/events', { globalId: o.GlobalId, ...JSON.parse(o.Payload) }, cfg)
          : await peerCall(db, 'POST', '/update', { globalId: o.GlobalId, identity: JSON.parse(o.Payload) }, cfg);
      // رد من المنشأة التانية (حتى لو رفض لسبب ثابت زي «مش مربوط عندي») مش بنعيده
      if (r.status > 0 && r.status < 500) { await db.run('UPDATE PeerOutbox SET DoneAt = ?, Attempts = Attempts + 1, LastError = ? WHERE Id = ?', [new Date(), r.ok ? null : String(r.error).slice(0, 300), o.Id]); sent++; continue; }
      await db.run('UPDATE PeerOutbox SET Attempts = Attempts + 1, LastError = ? WHERE Id = ?', [String(r.error || 'فشل').slice(0, 300), o.Id]);
      break;
    }
    const left = Number((await db.one('SELECT COUNT(*) AS N FROM PeerOutbox WHERE DoneAt IS NULL'))?.N) || 0;
    return { sent, pending: left };
  } finally { flushing = false; }
}

// ---- دخول موحّد: المستخدم بيتنقل للمنشأة التانية بنفس اسمه من غير ما يكتب كلمة سر (توقيع بمفتاح الربط، صالح دقيقة، مرة واحدة) ----
const sig = (key, u, ts, n) => createHmac('sha256', key).update(`${u}|${ts}|${n}`).digest('hex');
export function signSwitch(key, username) {
  const ts = Date.now(), n = randomUUID().replace(/-/g, '').slice(0, 16);
  return { u: username, t: ts, n, s: sig(key, username, ts, n) };
}
const usedNonces = new Map();
export function verifySwitch(key, q) {
  const ts = Number(q.t), n = String(q.n || ''), u = String(q.u || '');
  if (!key || !u || !n || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60e3) return false;
  const want = Buffer.from(sig(key, u, ts, n)), got = Buffer.from(String(q.s || ''));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  for (const [k, v] of usedNonces) if (Date.now() - v > 120e3) usedNonces.delete(k);
  if (usedNonces.has(n)) return false;
  usedNonces.set(n, Date.now());
  return true;
}
