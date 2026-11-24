// الدخول والجلسات والصلاحيات
import { PERM_LABELS } from './perm-catalog.js';
import { DEFAULT_ROLE_META, DEFAULT_ROLE_HOME } from './role-meta.js';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';
import { HttpError, forbidden } from './util.js';
import { R } from './runtime.js';
import { moduleOfPerm } from '../../shared/modules.js';

/** الأدوار الافتراضية (قالب البداية). بتتزرع في قاعدة البيانات مرة واحدة، وبعدها قاعدة البيانات هي المرجع */
export const DEFAULT_ROLES = {
  reception: 'موظف استقبال',
  reviewer: 'مراجع تعاقدات',
  supervisor: 'مشرف الاستقبال',
  cashier: 'موظف خزينة',
  radiology: 'قسم الأشعة',
  lab: 'المعمل',
  accounts: 'حسابات الإقامة',
  accsuper: 'مشرف الحسابات',
  storekeeper: 'أمين المخزن',
  storeacc: 'حسابات المخزن',
  pharmacist: 'الصيدلية',
  nurse: 'تمريض / مخزن قسم',
  claims: 'حسابات التعاقدات',
  finance: 'الحسابات العامة',
  financemgr: 'المدير المالي',
  cathacct: 'محاسب ومخزن الصفا كاث',
  genacct: 'محاسب عام (المنشأتين)',
  manager: 'المدير',
};

const RECEPTION = [
  'patients.read', 'patients.write', 'visits.read', 'visits.write',
  'cash.collect', 'cash.discount', 'receipts.read', 'receipts.cancelOwnOpenShift',
  'admissions.read', 'admissions.write', 'beds.status',
  'payers.read', 'approvals.read', 'approvals.create', 'shift.close', 'orders.create',
  'rad.read', 'rad.deliver', 'lab.read', 'lab.deliver', 'visit.stock', 'claims.fix',
];
// حسابات الإقامة: كتابة التذكرة وقفلها، وتسجيل اللي اتنسى بعد الخروج
const ACCOUNTS = [
  'patients.read', 'visits.read', 'admissions.read', 'adm.bill', 'adm.close', 'late.create', 'orders.create',
];
export const DEFAULT_PERMISSIONS = {
  reception: RECEPTION,
  reviewer: ['patients.read', 'visits.read', 'receipts.read', 'admissions.read', 'payers.read', 'approvals.read', 'approvals.create', 'approvals.review', 'rad.read', 'lab.read'],
  radiology: ['patients.read', 'visits.read', 'admissions.read', 'rad.read', 'rad.work', 'rad.report', 'rad.templates', 'rad.deliver'],
  lab: ['patients.read', 'visits.read', 'admissions.read', 'lab.read', 'lab.work', 'lab.verify', 'lab.templates', 'lab.deliver'],
  supervisor: [...RECEPTION, 'receipts.cancelAny', 'reports.shifts', 'reports.treasury', 'orders.cancelAny', 'stock.return'],
  cashier: ['patients.read', 'visits.read', 'admissions.read', 'payers.read', 'approvals.read', 'receipts.read', 'receipts.cancelOwnOpenShift',
    'cash.collect', 'cash.cashier', 'shift.close', 'reports.treasury', 'orders.cancelAny', 'fin.voucher'],
  accounts: ACCOUNTS,
  accsuper: [...ACCOUNTS, 'adm.reopen', 'late.decide', 'stock.edit', 'reports.late'],
  // المخازن: كل واحد على المخازن المربوطة بيه (Users.StoreIds)، وحسابات المخزن على الكل
  storekeeper: ['patients.read', 'stock.view', 'stock.request', 'stock.issue', 'stock.receive'],
  storeacc: ['patients.read', 'stock.view', 'stock.all', 'stock.purchase', 'stock.edit', 'stock.request', 'stock.issue', 'stock.receive', 'reports.stock', 'reports.pharmacy', 'stock.count', 'stock.waste'],
  // الصيدلية: بتبيع وبتحصّل بنفسها وبتقفّل ورديتها وتسلّم، وبتعمل المرتجع
  pharmacist: ['patients.read', 'patients.write', 'visits.read', 'visits.write', 'cash.collect', 'receipts.read', 'receipts.cancelOwnOpenShift', 'shift.close',
    'visit.stock', 'pharmacy.sell', 'stock.return', 'payers.read', 'stock.view', 'stock.request', 'stock.issue', 'stock.receive', 'reports.pharmacy'],
  nurse: ['patients.read', 'admissions.read', 'stock.view', 'stock.request', 'stock.receive'],
  // حسابات التعاقدات: مراجعة الحالات والمطالبة الشهرية والشيكات والمرفوضات
  claims: ['patients.read', 'visits.read', 'admissions.read', 'receipts.read', 'payers.read', 'approvals.read', 'approvals.create', 'claims.review', 'claims.manage', 'claims.fix', 'payers.manage'],
  // الحسابات العامة: صرف الدكاترة، الموردين، المصروفات، الأقساط (الصرف النقدي بإذن بتصرفه الخزينة)
  finance: ['patients.read', 'fin.view', 'fin.payout', 'fin.supplier', 'fin.expense', 'fin.oblig'],
  // المدير المالي: بيعتمد مستحقات الأطباء ويعدّلها، وبيعتمد المصروفات
  financemgr: ['patients.read', 'fin.view', 'fin.dash', 'fin.payout', 'fin.approve', 'fin.payoutEdit', 'fin.supplier', 'fin.expense', 'fin.oblig', 'expense.approve', 'ledger.view', 'ledger.post', 'ledger.reverse'],
  // محاسب ومخزن الصفا كاث: الفواتير والطباعة والرفع، المخزن والأصناف والتحويلات، التحصيل ومستحقات الشركات
  cathacct: ['patients.read', 'patients.write', 'visits.read', 'visits.write', 'cash.collect', 'receipts.read', 'receipts.cancelOwnOpenShift', 'shift.close', 'visit.stock',
    'pharmacy.sell', 'stock.return', 'stock.view', 'stock.request', 'stock.issue', 'stock.receive', 'reports.pharmacy',
    'payers.read', 'payers.manage', 'approvals.read', 'approvals.create', 'claims.review', 'claims.manage', 'claims.fix',
    'fin.view', 'fin.supplier', 'fin.expense', 'fin.oblig', 'ledger.view', 'peer.switch', 'eta.view', 'eta.submit'],
  // المحاسب العام: بيشوف حسابات المستشفى والكاث (دخول واحد وزر تبديل)
  genacct: ['patients.read', 'fin.view', 'fin.dash', 'fin.payout', 'fin.supplier', 'fin.expense', 'fin.oblig', 'ledger.view', 'ledger.post', 'peer.switch', 'eta.view', 'eta.submit'],
  manager: ['*'],
};
/** الأدوار والصلاحيات الشغّالة دلوقتي (بتتحمّل من قاعدة البيانات، والمحتوى بيتبدّل في نفس الكائن). قبل التحميل = القالب الافتراضي */
export const ROLES = { ...DEFAULT_ROLES };
export const ROLE_HOME = { ...DEFAULT_ROLE_HOME };
export const PERMISSIONS = Object.fromEntries(Object.entries(DEFAULT_PERMISSIONS).map(([k, v]) => [k, [...v]]));

/** زرع الأدوار الافتراضية لو الجدول فاضي (مرة واحدة) */
export async function seedRoles(db) {
  if (Number((await db.one('SELECT COUNT(*) AS N FROM Roles'))?.N)) return 0;
  let i = 1;
  for (const [code, name] of Object.entries(DEFAULT_ROLES)) {
    const [desc, color] = DEFAULT_ROLE_META[code] || [null, null];
    await db.insert('Roles', { Code: code, Name: name, Description: desc, Color: color, Home: DEFAULT_ROLE_HOME[code] || '/', IsSystem: 1, Active: 1, SortOrder: i++ });
    for (const p of new Set(DEFAULT_PERMISSIONS[code] || [])) await db.insert('RolePermissions', { RoleCode: code, Perm: p });
  }
  return i - 1;
}
/** أدوار افتراضية اتضافت بعد أول زرع: بتتضاف لو ناقصة (الأدوار الموجودة ما بتتلمسش) */
export async function ensureDefaultRoles(db) {
  const have = new Set((await db.query('SELECT Code FROM Roles')).map((r) => r.Code));
  if (!have.size) return 0;
  let n = 0, i = have.size + 1;
  for (const code of ['financemgr', 'cathacct', 'genacct']) {
    if (have.has(code) || !DEFAULT_ROLES[code]) continue;
    const [desc, color] = DEFAULT_ROLE_META[code] || [null, null];
    await db.insert('Roles', { Code: code, Name: DEFAULT_ROLES[code], Description: desc, Color: color, Home: DEFAULT_ROLE_HOME[code] || '/', IsSystem: 1, Active: 1, SortOrder: i++ });
    for (const p of new Set(DEFAULT_PERMISSIONS[code] || [])) await db.insert('RolePermissions', { RoleCode: code, Perm: p });
    n++;
  }
  return n;
}
/** تحميل الأدوار والصلاحيات من قاعدة البيانات للذاكرة */
export async function loadRoles(db) {
  const roles = await db.query('SELECT Code, Name, Home FROM Roles ORDER BY SortOrder, Code');
  if (!roles.length) return;
  const perms = await db.query('SELECT RoleCode, Perm FROM RolePermissions');
  for (const k of Object.keys(ROLES)) delete ROLES[k];
  for (const k of Object.keys(PERMISSIONS)) delete PERMISSIONS[k];
  for (const k of Object.keys(ROLE_HOME)) delete ROLE_HOME[k];
  for (const r of roles) { ROLES[r.Code] = r.Name; ROLE_HOME[r.Code] = r.Home || '/'; PERMISSIONS[r.Code] = []; }
  for (const x of perms) PERMISSIONS[x.RoleCode]?.push(x.Perm);
}

/** صلاحيات بيفعّلها المدير لمستخدم بعينه (فوق صلاحيات دوره) */
export const GRANTS = {
  'stock.negative': 'يصرف أو يبيع حتى لو الرصيد صفر أو سالب',
  'stock.direct': 'يحوّل تحويل مباشر (يتسجل في المخزن التاني من غير استلام)',
  'expense.direct': 'يسجّل مصروف مباشر من غير موافقة المدير',
};

export function can(user, perm) {
  const mod = moduleOfPerm(perm);
  if (mod && R.modules[mod] === false) return false; // القسم موقوف من الإعدادات
  const list = PERMISSIONS[user?.role] || [];
  if (list.includes('*')) return true; // المدير ما بيتشالش منه حاجة
  if (user?.denied?.includes(perm)) return false;
  return list.includes(perm) || !!user?.grants?.includes(perm);
}
/** صلاحيات المستخدم كلها (الدور + الإضافية) */
export function permsOf(user) {
  const all = [...new Set([...(PERMISSIONS[user?.role] || []), ...(user?.grants || [])])];
  return all.includes('*') ? all : all.filter((p) => !user?.denied?.includes(p));
}
export function parseList(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function need(user, perm) {
  if (!can(user, perm)) throw forbidden();
}

export const hashPassword = (pw) => bcrypt.hash(String(pw), 10);
export const verifyPassword = (pw, hash) => bcrypt.compare(String(pw), hash);
const sha = (s) => createHash('sha256').update(s).digest('hex');

export const COOKIE = 'elsafa_sid';

export async function createSession(db, userId, hours) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await db.insert('Sessions', {
    TokenHash: sha(token), UserId: userId, CreatedAt: now,
    ExpiresAt: new Date(now.getTime() + hours * 3600e3), LastSeenAt: now,
  });
  return token;
}

export async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM Sessions WHERE TokenHash = ?', [sha(token)]);
}

/** إنهاء جلسات مستخدم (ما عدا الجلسة الحالية لو اتبعتت) */
export async function destroyUserSessions(db, userId, exceptToken = null) {
  if (exceptToken) await db.run('DELETE FROM Sessions WHERE UserId = ? AND TokenHash <> ?', [userId, sha(exceptToken)]);
  else await db.run('DELETE FROM Sessions WHERE UserId = ?', [userId]);
}

export async function userFromToken(db, token) {
  if (!token) return null;
  const row = await db.one(
    `SELECT s.Id AS SessionId, s.ExpiresAt, s.LastSeenAt, u.Id, u.Username, u.FullName, u.Role, u.Active, u.Grants, u.Denied, u.StoreIds
       FROM Sessions s JOIN Users u ON u.Id = s.UserId WHERE s.TokenHash = ?`, [sha(token)]);
  if (!row) return null;
  const now = new Date();
  if (new Date(row.ExpiresAt) < now || !(row.Active === true || row.Active === 1)) {
    await db.run('DELETE FROM Sessions WHERE Id = ?', [row.SessionId]);
    return null;
  }
  // تحديث آخر نشاط مرة كل 5 دقايق بس
  if (now - new Date(row.LastSeenAt) > 5 * 60e3) {
    await db.run('UPDATE Sessions SET LastSeenAt = ? WHERE Id = ?', [now, row.SessionId]);
  }
  return {
    id: row.Id, username: row.Username, name: row.FullName, role: row.Role,
    grants: parseList(row.Grants).filter((g) => PERM_LABELS[g]), denied: parseList(row.Denied).filter((g) => PERM_LABELS[g]), stores: parseList(row.StoreIds).map(Number).filter(Boolean),
  };
}

/** مستخدم نشط بالاسم (للتحصيل المدمج بين المنشأتين: الكاشير بيشتغل باسمه في المنشأة التانية) */
export async function userByUsername(db, username) {
  const row = await db.one('SELECT Id, Username, FullName, Role, Active, Grants, Denied, StoreIds FROM Users WHERE Username = ?', [String(username || '')]);
  if (!row || !(row.Active === true || row.Active === 1)) return null;
  return {
    id: row.Id, username: row.Username, name: row.FullName, role: row.Role,
    grants: parseList(row.Grants).filter((g) => PERM_LABELS[g]), denied: parseList(row.Denied).filter((g) => PERM_LABELS[g]), stores: parseList(row.StoreIds).map(Number).filter(Boolean),
  };
}

/** حماية بسيطة من تخمين كلمة السر */
const attempts = new Map();
export function checkLoginRate(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, until: 0, first: now };
  if (a.until > now) {
    throw new HttpError(429, `محاولات كتير. جرّب تاني بعد ${Math.ceil((a.until - now) / 60000)} دقيقة`);
  }
  return {
    fail() {
      if (now - a.first > 15 * 60e3) { a.n = 0; a.first = now; }
      a.n++;
      if (a.n >= 6) { a.until = now + 5 * 60e3; a.n = 0; }
      attempts.set(key, a);
    },
    ok() { attempts.delete(key); },
  };
}

export async function audit(db, user, action, entity, entityId, { old, now: nv, note } = {}) {
  await db.insert('AuditLog', {
    At: new Date(), UserId: user?.id ?? null, Action: action, Entity: entity, EntityId: entityId ?? null,
    OldValue: old === undefined ? null : JSON.stringify(old),
    NewValue: nv === undefined ? null : JSON.stringify(nv),
    Note: note ?? null,
  });
}
