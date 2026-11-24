// القوائم المرجعية (Lookups): الأقسام وأنواع الدخول وأنواع الغرف.
// القيم بيانات بتتعدل من الشاشة، والكود بيسأل عن «السلوك» (Behavior) مش عن الاسم.
// الكاش متزامن (زي runtime.js) وبيتحمّل عند التشغيل وبعد أي تعديل.

export const DOMAINS = {
  dept: {
    title: 'الأقسام', single: 'قسم', icon: 'steth', codePrefix: 'd',
    hint: 'كل قسم له اسم ولون وأيقونة وسلوك. القسم الجديد بيظهر لوحده في الخدمات والزيارات والتقارير.',
    behaviors: {
      clinic: ['عيادة', 'خدمات بدكتور وكشف'],
      emergency: ['طوارئ', 'الدفع بعد الخدمة (الزيارة تفضل مفتوحة لحد الدفع)'],
      lab: ['معمل', 'قايمة شغل التحاليل وعينات ونتايج'],
      radiology: ['أشعة', 'قايمة شغل الفحوصات وتقارير'],
      ward: ['خدمات الإقامة', 'خدمات بتتسجل على حساب المريض الداخلي'],
      or: ['عمليات', 'عمليات وباكدج بليالي شاملة'],
      service: ['خدمة عامة', 'خدمات بسيطة من غير قايمة شغل (علاج طبيعي مثلًا)'],
    },
  },
  admission_type: {
    title: 'أنواع الدخول', single: 'نوع دخول', icon: 'bed', codePrefix: 'a',
    hint: 'كل نوع دخول مربوط بنوع غرفة بيناسبه.',
    behaviors: { standard: ['عادي', 'دخول إقامة عادي'], surgery: ['عمليات', 'بيسأل عن العملية المتوقعة'] },
  },
  room_kind: {
    title: 'أنواع الغرف', single: 'نوع غرفة', icon: 'door', codePrefix: 'r',
    hint: 'تصنيف الغرف (إقامة، عناية، حضانة…) وبيتربط بيه مخزن القسم وأنواع الدخول.',
    behaviors: null,
  },
};

export const LK = { rows: [] };

/** خرايط كود ← اسم بتتحدّث في نفس الأوبجكت (الملفات اللي استوردتها بتشوف التحديث) */
export const LIVE = { DEPTS: {}, VISIT_TYPES: {}, VISIT_NAMES: {}, ADM_TYPES: {}, KIND_FOR_TYPE: {}, KIND_NAMES: {}, STORE_DEPTS: {} };
function refill(target, entries) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, Object.fromEntries(entries));
}

const parse = (m) => { try { return m ? JSON.parse(m) : {}; } catch { return {}; } };
const fromRow = (r) => ({
  id: r.Id, domain: r.Domain, code: r.Code, name: r.Name, short: r.ShortName || r.Name, color: r.Color || null, icon: r.Icon || null,
  behavior: r.Behavior || null, sort: Number(r.SortOrder), active: !!r.Active, meta: parse(r.Meta),
});

export async function loadLookups(db) {
  const rows = await db.query('SELECT * FROM LookupValues ORDER BY Domain, SortOrder, Id');
  LK.rows = rows.map(fromRow);
  const of = (d) => LK.rows.filter((r) => r.domain === d);
  refill(LIVE.DEPTS, of('dept').map((d) => [d.code, d.name]));
  refill(LIVE.VISIT_TYPES, of('dept').filter((d) => d.meta.visit).map((d) => [d.code, d.name]));
  refill(LIVE.VISIT_NAMES, [...Object.entries(LIVE.VISIT_TYPES), ['pharmacy', 'الصيدلية']]);
  refill(LIVE.ADM_TYPES, of('admission_type').map((r) => [r.code, r.name]));
  refill(LIVE.KIND_FOR_TYPE, of('admission_type').map((r) => [r.code, r.meta.roomKind]));
  refill(LIVE.KIND_NAMES, of('room_kind').map((r) => [r.code, r.name]));
  // مخازن الأقسام: الأقسام (من غير الإقامة) + أنواع الغرف الخاصة (عناية، حضانة…)
  const dep = of('dept').filter((d) => d.behavior !== 'ward').map((d) => [d.code, d.name]);
  const codes = new Set(dep.map(([c]) => c));
  refill(LIVE.STORE_DEPTS, [...dep, ...of('room_kind').filter((r) => r.code !== 'ward' && !codes.has(r.code)).map((r) => [r.code, r.name])]);
  return LK.rows;
}

export const rowsOf = (domain, { active = false } = {}) => LK.rows.filter((r) => r.domain === domain && (!active || r.active));
export const rowOf = (domain, code) => LK.rows.find((r) => r.domain === domain && r.code === code) || null;

// ---- الأقسام ----
export const deptRow = (code) => rowOf('dept', code);
export const deptName = (code) => deptRow(code)?.name || code || '';
export const deptBehavior = (code) => deptRow(code)?.behavior || null;
export const deptIs = (code, ...behaviors) => behaviors.includes(deptBehavior(code));
/** أكواد الأقسام (النشطة وغير النشطة) اللي سلوكها من المذكورين */
export const deptCodes = (...behaviors) => rowsOf('dept').filter((d) => behaviors.includes(d.behavior)).map((d) => d.code);
/** للـ SQL: ('lab','lab2') — الأكواد بتتحقق بنمط آمن، ولو مفيش قسم بالسلوك ده بيرجّع قايمة فاضية آمنة */
export function deptSql(...behaviors) {
  const codes = deptCodes(...behaviors).filter((c) => /^[A-Za-z0-9_]+$/.test(c));
  return `(${(codes.length ? codes : ['__none__']).map((c) => `'${c}'`).join(',')})`;
}
/** أقسام الخدمات النشطة اللي بتتسجل منها زيارات خارجية (كل قسم Meta.visit) */
export const visitDepts = () => rowsOf('dept', { active: true }).filter((d) => d.meta.visit);
export const visitTypeCodes = () => visitDepts().map((d) => d.code);
export const allDeptCodes = (activeOnly = true) => rowsOf('dept', { active: activeOnly }).map((d) => d.code);
export const isVisitType = (code) => !!visitDepts().find((d) => d.code === code);
/** بادئة كود الخدمة (CL, LAB…) */
export const deptPrefix = (code) => deptRow(code)?.meta.prefix || String(code || 'SV').slice(0, 3).toUpperCase();
/** الدفع الافتراضي للقسم */
export const deptPayDefault = (code) => (deptRow(code)?.meta.pay === 'after' ? 'after' : 'before');
/** اسم القسم/النوع كخريطة: كود ← اسم (لكل الأقسام) */
export const deptNames = () => Object.fromEntries(rowsOf('dept').map((d) => [d.code, d.name]));

// ---- أنواع الدخول وأنواع الغرف ----
export const admTypeRow = (code) => rowOf('admission_type', code);
export const admTypeNames = () => Object.fromEntries(rowsOf('admission_type').map((r) => [r.code, r.name]));
export const admRoomKind = (code) => admTypeRow(code)?.meta.roomKind || null;
export const admIsSurgery = (code) => admTypeRow(code)?.behavior === 'surgery';
/** نوع الدخول المناسب لنوع غرفة (أول نوع نشط مربوط بيه) */
export const admTypeForKind = (kind) => rowsOf('admission_type', { active: true }).find((r) => r.meta.roomKind === kind)?.code || null;
export const roomKindNames = () => Object.fromEntries(rowsOf('room_kind').map((r) => [r.code, r.name]));
export const roomKindRows = () => rowsOf('room_kind', { active: true });

/** كل القوائم للواجهة */
export function publicView() {
  return Object.fromEntries(Object.keys(DOMAINS).map((d) => [d, rowsOf(d)]));
}
