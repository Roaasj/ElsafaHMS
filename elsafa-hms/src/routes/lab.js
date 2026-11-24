// المعمل: قايمة الشغل (مجمّعة بالمريض)، سحب العينات والملصقات، النتايج والمعدلات، الاعتماد، المعامل الخارجية، والتسليم
import { deptSql } from '../lib/lookups.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, intId, str, cairoDate } from '../lib/util.js';
import { toIso, toBool, toDateStr } from '../db/index.js';
import { ROOT } from '../config.js';
import { linkLabServices } from '../lib/lab-tests.js';

export const SECTIONS = { hematology: 'أمراض دم', chemistry: 'كيمياء', hormones: 'هرمونات', serology: 'مناعة وفيروسات', urine: 'بول', stool: 'براز', coagulation: 'سيولة', other: 'أخرى' };
export const SECTION_EN = { hematology: 'HEMATOLOGY', chemistry: 'CLINICAL CHEMISTRY', hormones: 'HORMONES', serology: 'IMMUNOLOGY & SEROLOGY', urine: 'URINE', stool: 'STOOL', coagulation: 'COAGULATION', other: 'OTHER' };
export const SAMPLES = { blood: 'دم', serum: 'سيرم', urine: 'بول', stool: 'براز', swab: 'مسحة', other: 'أخرى' };
const UP_DIR = path.join(ROOT, 'data', 'uploads', 'lab');
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const GROUP_OF = { waiting: 'waiting', collected: 'inlab', done: 'inlab', sent: 'inlab', verified: 'ready', delivered: 'delivered' };

const latin = (v) => String(v ?? '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632).replace(/٫/g, '.').trim();

// ---------- المعدلات والعلامات ----------
export function ageYearsOf(p, at = new Date()) {
  const bd = toDateStr(p?.BirthDate);
  if (bd) { const b = new Date(bd + 'T00:00:00Z'); return (at - b) / (365.25 * 24 * 3600e3); }
  if (p?.AgeYears != null) {
    const rec = p.AgeRecordedAt ? new Date(p.AgeRecordedAt) : at;
    return Number(p.AgeYears) + Math.max(0, (at - rec) / (365.25 * 24 * 3600e3));
  }
  return null;
}
export function pickRange(ranges, sex, age) {
  const list = (Array.isArray(ranges) ? ranges : []).filter((r) => (!r.s || r.s === sex)
    && (r.a0 == null || (age != null && age >= r.a0)) && (r.a1 == null || (age != null && age < r.a1)));
  list.sort((a, b) => ((b.s ? 1 : 0) + (b.a0 != null || b.a1 != null ? 2 : 0)) - ((a.s ? 1 : 0) + (a.a0 != null || a.a1 != null ? 2 : 0)));
  return list[0] || null;
}
const fmtN = (v, d) => (v == null ? '' : Number(v).toFixed(d ?? (Number.isInteger(Number(v)) ? 0 : 1)));
export function refTextFor(param, sex, age) {
  if (param.RefText) return param.RefText;
  if (param.Kind === 'select' || param.Kind === 'text') return param.NormalText || '';
  const r = pickRange(parse(param.Ranges), sex, age);
  if (!r) return '';
  const d = param.Decimals;
  if (r.lo != null && r.hi != null) return `${fmtN(r.lo, d)} – ${fmtN(r.hi, d)}`;
  if (r.hi != null) return `< ${fmtN(r.hi, d)}`;
  if (r.lo != null) return `> ${fmtN(r.lo, d)}`;
  return '';
}
export function flagFor(param, value, sex, age) {
  const v = latin(value);
  if (!v) return null;
  if (param.Kind === 'num') {
    const n = Number(v.replace(/[<>]/g, ''));
    if (!Number.isFinite(n)) return null;
    const r = pickRange(parse(param.Ranges), sex, age);
    if (!r) return null;
    if (r.lo != null && n < r.lo) return 'L';
    if (r.hi != null && n > r.hi) return 'H';
    return null;
  }
  if (param.Kind === 'select' && param.NormalText) return v.toLowerCase() === String(param.NormalText).toLowerCase() ? null : 'A';
  return null;
}
function parse(j) { try { return j ? JSON.parse(j) : []; } catch { return []; } }

// ---------- التحاليل (القوالب) ----------
async function testsIndex(db) {
  const tests = await db.query('SELECT * FROM LabTests ORDER BY SortOrder, Id');
  const params = await db.query('SELECT * FROM LabParams WHERE Active = 1 ORDER BY TestId, SortOrder, Id');
  const byTest = new Map();
  for (const p of params) { if (!byTest.has(p.TestId)) byTest.set(p.TestId, []); byTest.get(p.TestId).push(p); }
  const byService = new Map();
  for (const t of tests) if (t.ServiceId && toBool(t.Active)) byService.set(t.ServiceId, t);
  return { tests, byService, params: byTest, byId: new Map(tests.map((t) => [t.Id, t])) };
}
function testFor(idx, serviceId, name) {
  if (serviceId && idx.byService.has(serviceId)) return idx.byService.get(serviceId);
  const n = String(name || '').toLowerCase();
  return idx.tests.find((t) => toBool(t.Active) && t.Keywords && t.Keywords.split('|').some((k) => k && n.includes(k.toLowerCase()))) || null;
}
const GENERIC = [{ Id: null, Name: 'Result', Unit: null, Kind: 'text', Options: null, NormalText: null, Decimals: null, Ranges: null, RefText: null, SortOrder: 0 }];

function testDto(t, params) {
  return {
    id: t.Id, code: t.Code, name: t.Name, arName: t.ArName, serviceId: t.ServiceId, keywords: t.Keywords, section: t.Section, sectionName: SECTIONS[t.Section],
    sample: t.Sample, sampleName: SAMPLES[t.Sample], tube: t.Tube, hours: Number(t.Hours), external: toBool(t.External), externalLab: t.ExternalLab,
    comment: t.Comment, active: toBool(t.Active), sort: Number(t.SortOrder || 0),
    params: (params || []).map((p) => ({ id: p.Id, name: p.Name, unit: p.Unit, kind: p.Kind, options: p.Options, normal: p.NormalText, decimals: p.Decimals, ranges: parse(p.Ranges), refText: p.RefText })),
  };
}

// ---------- قايمة الشغل ----------
const ITEM_SQL = {
  v: `SELECT i.Id AS ItemId, i.ServiceId, i.ServiceName AS Name, i.AddedAt, d.Name AS DoctorName, i.PaidReceiptId, i.PayTiming, i.Status AS ItemStatus,
        v.PatientId, v.Id AS VisitId, v.VisitNo, NULL AS AdmissionId, NULL AS AdmissionNo, NULL AS BedLabel, NULL AS RoomNo
      FROM VisitItems i JOIN Visits v ON v.Id = i.VisitId LEFT JOIN Doctors d ON d.Id = i.DoctorId`,
  a: `SELECT i.Id AS ItemId, i.ServiceId, i.Name AS Name, i.AddedAt, d.Name AS DoctorName, NULL AS PaidReceiptId, 'after' AS PayTiming, i.Status AS ItemStatus,
        a.PatientId, NULL AS VisitId, NULL AS VisitNo, a.Id AS AdmissionId, a.AdmissionNo, b.Label AS BedLabel, rm.Number AS RoomNo
      FROM AdmissionItems i JOIN Admissions a ON a.Id = i.AdmissionId LEFT JOIN Doctors d ON d.Id = a.DoctorId
      LEFT JOIN Beds b ON b.Id = a.BedId LEFT JOIN Rooms rm ON rm.Id = b.RoomId`,
};
const WORK_SQL = `SELECT w.*, u1.FullName AS CollectedByName, u2.FullName AS EnteredByName, u3.FullName AS VerifiedByName, u4.FullName AS DeliveredByName
  FROM LabWork w LEFT JOIN Users u1 ON u1.Id = w.CollectedBy LEFT JOIN Users u2 ON u2.Id = w.EnteredBy LEFT JOIN Users u3 ON u3.Id = w.VerifiedBy LEFT JOIN Users u4 ON u4.Id = w.DeliveredBy`;

function groupKeyOf(src, it) {
  return src === 'v' ? `V${it.VisitId}` : `A${it.AdmissionId}-${cairoDate(new Date(it.AddedAt)).replace(/-/g, '')}`;
}

async function loadItems(db, { patientId = null, since = null, groupKey = null } = {}) {
  const prm = [];
  let wv = `WHERE i.Dept IN ${deptSql('lab')} AND i.Status = 'active' AND (i.PaidReceiptId IS NOT NULL OR i.PayTiming = 'after')`;
  let wa = `WHERE i.Dept IN ${deptSql('lab')} AND i.Status = 'active'`;
  const pv = [], pa = [];
  if (patientId) { wv += ' AND v.PatientId = ?'; pv.push(patientId); wa += ' AND a.PatientId = ?'; pa.push(patientId); }
  if (since) { wv += ' AND i.AddedAt >= ?'; pv.push(since); wa += ' AND i.AddedAt >= ?'; pa.push(since); }
  let vis = [], adm = [];
  if (groupKey) {
    const m = /^V(\d+)$|^A(\d+)-(\d{8})$/.exec(groupKey);
    if (!m) throw notFound('المجموعة مش موجودة');
    if (m[1]) vis = await db.query(`${ITEM_SQL.v} ${wv} AND v.Id = ?`, [...pv, Number(m[1])]);
    else adm = (await db.query(`${ITEM_SQL.a} ${wa} AND a.Id = ?`, [...pa, Number(m[2])])).filter((x) => groupKeyOf('a', x) === groupKey);
  } else {
    vis = await db.query(`${ITEM_SQL.v} ${wv}`, pv);
    adm = await db.query(`${ITEM_SQL.a} ${wa}`, pa);
  }
  void prm;
  const vIds = vis.map((x) => x.ItemId), aIds = adm.map((x) => x.ItemId);
  const works = [];
  if (vIds.length) works.push(...await db.query(`${WORK_SQL} WHERE w.Status <> 'cancelled' AND w.VisitItemId IN (${vIds.map(() => '?').join(',')})`, vIds));
  if (aIds.length) works.push(...await db.query(`${WORK_SQL} WHERE w.Status <> 'cancelled' AND w.AdmissionItemId IN (${aIds.map(() => '?').join(',')})`, aIds));
  const wv2 = new Map(works.filter((w) => w.VisitItemId).map((w) => [w.VisitItemId, w]));
  const wa2 = new Map(works.filter((w) => w.AdmissionItemId).map((w) => [w.AdmissionItemId, w]));
  return [...vis.map((it) => ({ src: 'v', it, w: wv2.get(it.ItemId) || null })), ...adm.map((it) => ({ src: 'a', it, w: wa2.get(it.ItemId) || null }))];
}

async function patientsMap(db, ids) {
  const u = [...new Set(ids)].filter(Boolean);
  if (!u.length) return new Map();
  const rows = await db.query(`SELECT Id, FullName, PatientNo, Sex, AgeYears, AgeRecordedAt, BirthDate, Phone FROM Patients WHERE Id IN (${u.map(() => '?').join(',')})`, u);
  return new Map(rows.map((r) => [r.Id, r]));
}

function testRow(x, idx, now = Date.now()) {
  const { src, it, w } = x;
  const t = w?.TestId ? idx.byId.get(w.TestId) : testFor(idx, it.ServiceId, it.Name);
  const st = w?.Status || 'waiting';
  const due = w?.DueAt ? new Date(w.DueAt).getTime() : null;
  return {
    key: `${src}${it.ItemId}`, workId: w?.Id || null, accNo: w?.AccNo || null, service: it.Name, status: st, group: GROUP_OF[st],
    testId: t?.Id || null, testName: t?.Name || null, code: t?.Code || null, section: t?.Section || 'other', sample: t?.Sample || 'other', tube: t?.Tube || null,
    external: !!(t && toBool(t.External)), externalLab: t?.ExternalLab || null,
    requestedAt: toIso(it.AddedAt), doctor: it.DoctorName || null,
    collectedAt: toIso(w?.CollectedAt), collectedBy: w?.CollectedByName || null, dueAt: toIso(w?.DueAt),
    overdue: ['collected', 'done', 'sent'].includes(st) && due != null && due < now,
    sentAt: toIso(w?.SentAt), sentTo: w?.SentTo || null, enteredAt: toIso(w?.EnteredAt), enteredBy: w?.EnteredByName || null,
    verifiedAt: toIso(w?.VerifiedAt), verifiedBy: w?.VerifiedByName || null, deliveredAt: toIso(w?.DeliveredAt), deliveredTo: w?.DeliveredTo || null,
    hasFile: !!w?.ExtFile, comment: w?.Comment || null,
    visitId: it.VisitId, visitNo: it.VisitNo, admissionId: it.AdmissionId, admissionNo: it.AdmissionNo, bed: it.BedLabel ? `${it.RoomNo}/${it.BedLabel}` : null,
    gkey: groupKeyOf(src, it), patientId: it.PatientId,
  };
}
function patientDto(p) {
  return p ? { id: p.Id, name: p.FullName, no: p.PatientNo, sex: p.Sex, ageYears: p.AgeYears, birthDate: toDateStr(p.BirthDate), phone: p.Phone } : null;
}
/** تجميع التحاليل بالمريض/الزيارة: كارت واحد للمريض */
function groupRows(rows, pm) {
  const g = new Map();
  for (const r of rows) {
    if (!g.has(r.gkey)) g.set(r.gkey, { gkey: r.gkey, patient: patientDto(pm.get(r.patientId)), visitId: r.visitId, visitNo: r.visitNo, admissionId: r.admissionId, admissionNo: r.admissionNo, bed: r.bed, doctor: r.doctor, tests: [] });
    g.get(r.gkey).tests.push(r);
  }
  const order = ['waiting', 'inlab', 'ready', 'delivered'];
  for (const x of g.values()) {
    x.requestedAt = x.tests.map((t) => t.requestedAt).sort()[0];
    x.group = order.find((o) => x.tests.some((t) => t.group === o));   // أقل مرحلة فيها
    x.overdue = x.tests.some((t) => t.overdue);
    x.accNo = x.tests.find((t) => t.accNo)?.accNo || null;
    x.counts = Object.fromEntries(order.map((o) => [o, x.tests.filter((t) => t.group === o).length]));
  }
  return [...g.values()];
}

async function verifyRequired(db) {
  return (await db.one("SELECT Value FROM AppSettings WHERE [Key] = 'labVerify'"))?.Value === '1';
}

async function groupDetail(db, gkey) {
  const items = await loadItems(db, { groupKey: gkey });
  if (!items.length) throw notFound('مفيش تحاليل هنا');
  const idx = await testsIndex(db);
  const pm = await patientsMap(db, [items[0].it.PatientId]);
  const p = pm.get(items[0].it.PatientId);
  const age = ageYearsOf(p), sex = p?.Sex;
  const workIds = items.filter((x) => x.w).map((x) => x.w.Id);
  const vals = workIds.length ? await db.query(`SELECT * FROM LabValues WHERE WorkId IN (${workIds.map(() => '?').join(',')}) ORDER BY WorkId, SortOrder, Id`, workIds) : [];
  const tests = items.map((x) => {
    const row = testRow(x, idx);
    const t = row.testId ? idx.byId.get(row.testId) : null;
    const params = t ? (idx.params.get(t.Id) || []) : GENERIC;
    const saved = x.w ? vals.filter((v) => v.WorkId === x.w.Id) : [];
    const values = (saved.length && ['done', 'verified', 'delivered'].includes(row.status) ? saved.map((v) => ({ paramId: v.ParamId, name: v.Name, unit: v.Unit, kind: v.Kind, value: v.Value, flag: v.Flag, refText: v.RefText }))
      : params.map((pp) => {
        const sv = saved.find((v) => v.ParamId === pp.Id || (!pp.Id && v.Name === pp.Name));
        return { paramId: pp.Id, name: pp.Name, unit: pp.Unit, kind: pp.Kind, options: pp.Options, normal: pp.NormalText, value: sv?.Value ?? '', flag: sv?.Flag || null, refText: refTextFor(pp, sex, age), ranges: parse(pp.Ranges) };
      }));
    // الاختيارات للبنود المحفوظة كمان (للتعديل)
    for (const v of values) { const pp = params.find((q) => q.Id === v.paramId); if (pp) { v.options = pp.Options; v.normal = pp.NormalText; v.ranges = parse(pp.Ranges); } }
    return { ...row, values };
  });
  tests.sort((a, b) => Object.keys(SECTIONS).indexOf(a.section) - Object.keys(SECTIONS).indexOf(b.section));
  const g = groupRows(tests, pm)[0];
  return { ...g, tests, patient: { ...patientDto(p), age: age == null ? null : Math.floor(age * 10) / 10 }, verifyRequired: await verifyRequired(db) };
}

/** سطر الشغل (بيتعمل أول ما المعمل يلمس التحليل) */
async function ensureWork(t, key, user) {
  const m = /^([va])(\d+)$/.exec(String(key || ''));
  if (!m) throw notFound('التحليل مش موجود');
  const src = m[1], itemId = Number(m[2]);
  const it = await t.one(`${ITEM_SQL[src]} WHERE i.Id = ? AND i.Dept IN ${deptSql('lab')}`, [itemId]);
  if (!it) throw notFound('التحليل مش موجود');
  if (it.ItemStatus !== 'active') throw conflict('التحليل ده اتلغى');
  if (src === 'v' && it.PaidReceiptId == null && it.PayTiming !== 'after') throw conflict('التحليل ده لسه ما اتدفعش');
  const w = await t.one(`SELECT * FROM LabWork WHERE Status <> 'cancelled' AND ${src === 'v' ? 'VisitItemId' : 'AdmissionItemId'} = ?`, [itemId]);
  if (w) return { w, it, src };
  const idx = await testsIndex(t);
  const test = testFor(idx, it.ServiceId, it.Name);
  const id = await t.insert('LabWork', {
    PatientId: it.PatientId, VisitItemId: src === 'v' ? itemId : null, AdmissionItemId: src === 'a' ? itemId : null, TestId: test?.Id || null,
    ServiceName: it.Name, Status: 'waiting', CreatedAt: new Date(),
  });
  return { w: await t.one('SELECT * FROM LabWork WHERE Id = ?', [id]), it, src, test };
}

export default function labRouter(db) {
  const r = router();

  r.get('/', async (req, res) => {
    need(req.user, 'lab.read');
    const since = new Date(Date.now() - 21 * 24 * 3600e3);
    const idx = await testsIndex(db);
    const items = await loadItems(db, { since });
    const now = Date.now();
    let rows = items.map((x) => testRow(x, idx, now));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : cairoDate();
    rows = rows.filter((x) => x.group !== 'delivered' || (x.deliveredAt && cairoDate(new Date(x.deliveredAt)) === date));
    const pm = await patientsMap(db, rows.map((x) => x.patientId));
    let groups = groupRows(rows, pm);
    const counts = { waiting: 0, inlab: 0, ready: 0, delivered: 0, overdue: 0 };
    for (const x of rows) counts[x.group]++;
    counts.overdue = rows.filter((x) => x.overdue).length;
    const g = ['waiting', 'inlab', 'ready', 'delivered', 'all'].includes(req.query.group) ? req.query.group : 'waiting';
    if (g !== 'all') groups = groups.filter((x) => x.tests.some((t) => t.group === g));
    const q = latin(req.query.q);
    if (q) groups = groups.filter((x) => x.patient?.name?.includes(q) || String(x.patient?.no) === q || String(x.accNo) === q || x.tests.some((t) => t.service.includes(q) || String(t.accNo) === q));
    groups.sort((a, b) => (b.overdue - a.overdue) || (a.requestedAt || '').localeCompare(b.requestedAt || ''));
    res.json({ groups, counts, date, verifyRequired: await verifyRequired(db) });
  });

  r.get('/patient/:id', async (req, res) => {
    need(req.user, 'lab.read');
    const idx = await testsIndex(db);
    const rows = (await loadItems(db, { patientId: intId(req.params.id) })).map((x) => testRow(x, idx));
    rows.sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
    res.json({ rows: rows.slice(0, 40) });
  });

  // ===== التحاليل (القوالب) =====
  r.get('/tests', async (req, res) => {
    need(req.user, 'lab.read');
    const idx = await testsIndex(db);
    const all = req.query.all === '1';
    const services = await db.query(`SELECT Id, Code, Name, Active FROM Services WHERE Dept IN ${deptSql('lab')} ORDER BY SortOrder, Id`);
    res.json({
      tests: idx.tests.filter((t) => all || toBool(t.Active)).map((t) => testDto(t, idx.params.get(t.Id))),
      services: services.map((s) => ({ id: s.Id, code: s.Code, name: s.Name, active: toBool(s.Active), testId: idx.tests.find((t) => t.ServiceId === s.Id)?.Id || null })),
      sections: SECTIONS, samples: SAMPLES,
    });
  });
  const testBody = (b) => {
    const errors = {};
    const name = str(b.name, 150);
    if (!name) errors.name = 'اكتب اسم التحليل';
    const code = (str(b.code, 30) || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!code) errors.code = 'اكتب كود (حروف إنجليزي)';
    if (!SECTIONS[b.section]) errors.section = 'اختار القسم';
    if (!SAMPLES[b.sample]) errors.sample = 'اختار نوع العينة';
    const hours = Number(latin(b.hours || 2));
    if (!Number.isFinite(hours) || hours < 0 || hours > 720) errors.hours = 'عدد الساعات مش صحيح';
    const params = (Array.isArray(b.params) ? b.params : []).map((p, i) => {
      const kind = ['num', 'text', 'select', 'header'].includes(p.kind) ? p.kind : 'num';
      const ranges = (Array.isArray(p.ranges) ? p.ranges : []).map((x) => ({
        s: ['M', 'F'].includes(x.s) ? x.s : '', a0: x.a0 === '' || x.a0 == null ? null : Number(latin(x.a0)), a1: x.a1 === '' || x.a1 == null ? null : Number(latin(x.a1)),
        lo: x.lo === '' || x.lo == null ? null : Number(latin(x.lo)), hi: x.hi === '' || x.hi == null ? null : Number(latin(x.hi)),
      })).filter((x) => [x.a0, x.a1, x.lo, x.hi].every((v) => v == null || Number.isFinite(v)) && (x.lo != null || x.hi != null));
      const pname = str(p.name, 120);
      if (!pname) errors[`p${i}`] = 'اسم البند فاضي';
      return { id: p.id ? Number(p.id) : null, name: pname, unit: str(p.unit, 40), kind, options: kind === 'select' ? str(p.options, 300) : null, normal: str(p.normal, 100),
        decimals: p.decimals === '' || p.decimals == null ? null : Math.max(0, Math.min(4, Number(p.decimals) || 0)), ranges: kind === 'num' ? ranges : [], refText: str(p.refText, 200), sort: i };
    });
    if (!params.filter((p) => p.kind !== 'header').length) errors.params = 'ضيف بند واحد على الأقل';
    if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
    return {
      row: { Code: code, Name: name, ArName: str(b.arName, 150), ServiceId: b.serviceId ? Number(b.serviceId) : null, Keywords: str(b.keywords, 300), Section: b.section, Sample: b.sample,
        Tube: str(b.tube, 30), Hours: Math.round(hours), External: b.external ? 1 : 0, ExternalLab: str(b.externalLab, 120), Comment: str(b.comment, 400), Active: b.active === false ? 0 : 1 },
      params,
    };
  };
  const saveParams = async (t, testId, params) => {
    const old = await t.query('SELECT Id FROM LabParams WHERE TestId = ?', [testId]);
    const keep = new Set();
    for (const p of params) {
      const row = { Name: p.name, Unit: p.unit, Kind: p.kind, Options: p.options, NormalText: p.normal, Decimals: p.decimals, Ranges: p.ranges.length ? JSON.stringify(p.ranges) : null, RefText: p.refText, SortOrder: p.sort, Active: 1 };
      if (p.id && old.some((o) => o.Id === p.id)) {
        keep.add(p.id);
        await t.run('UPDATE LabParams SET Name = ?, Unit = ?, Kind = ?, Options = ?, NormalText = ?, Decimals = ?, Ranges = ?, RefText = ?, SortOrder = ?, Active = 1 WHERE Id = ?',
          [row.Name, row.Unit, row.Kind, row.Options, row.NormalText, row.Decimals, row.Ranges, row.RefText, row.SortOrder, p.id]);
      } else keep.add(await t.insert('LabParams', { TestId: testId, ...row }));
    }
    for (const o of old) if (!keep.has(o.Id)) await t.run('UPDATE LabParams SET Active = 0 WHERE Id = ?', [o.Id]);
  };
  const uniqueChecks = async (t, row, id) => {
    if (await t.one('SELECT Id FROM LabTests WHERE Code = ? AND Id <> ?', [row.Code, id || 0])) throw bad('الكود ده مستخدم', { errors: { code: 'الكود ده مستخدم لتحليل تاني' } });
    if (row.ServiceId && await t.one('SELECT Id FROM LabTests WHERE ServiceId = ? AND Id <> ?', [row.ServiceId, id || 0])) throw bad('الخدمة دي مربوطة بتحليل تاني', { errors: { serviceId: 'الخدمة دي مربوطة بتحليل تاني' } });
  };
  r.post('/tests', async (req, res) => {
    need(req.user, 'lab.templates');
    const { row, params } = testBody(req.body || {});
    const id = await db.tx(async (t) => {
      await uniqueChecks(t, row, null);
      const max = await t.one('SELECT MAX(SortOrder) AS M FROM LabTests');
      const { External: ext, ...rowRest } = row; // External كلمة محجوزة: بتتكتب بأقواس في الإدراج
      const x = await t.insert('LabTests', { ...rowRest, '[External]': ext, SortOrder: Number(max?.M ?? 0) + 1, CreatedAt: new Date(), UpdatedAt: new Date() });
      await saveParams(t, x, params);
      await audit(t, req.user, 'lab.test', 'LabTest', x, { now: { name: row.Name } });
      return x;
    });
    const idx = await testsIndex(db);
    res.status(201).json({ test: testDto(idx.byId.get(id), idx.params.get(id)) });
  });
  r.put('/tests/:id', async (req, res) => {
    need(req.user, 'lab.templates');
    const id = intId(req.params.id);
    const { row, params } = testBody(req.body || {});
    await db.tx(async (t) => {
      if (!await t.one('SELECT Id FROM LabTests WHERE Id = ?', [id])) throw notFound('التحليل مش موجود');
      await uniqueChecks(t, row, id);
      await t.run(`UPDATE LabTests SET Code = ?, Name = ?, ArName = ?, ServiceId = ?, Keywords = ?, Section = ?, Sample = ?, Tube = ?, Hours = ?, [External] = ?, ExternalLab = ?, Comment = ?, Active = ?, UpdatedAt = ? WHERE Id = ?`,
        [row.Code, row.Name, row.ArName, row.ServiceId, row.Keywords, row.Section, row.Sample, row.Tube, row.Hours, row.External, row.ExternalLab, row.Comment, row.Active, new Date(), id]);
      await saveParams(t, id, params);
      await audit(t, req.user, 'lab.test', 'LabTest', id, { now: { name: row.Name } });
    });
    const idx = await testsIndex(db);
    res.json({ test: testDto(idx.byId.get(id), idx.params.get(id)) });
  });
  r.post('/tests/link', async (req, res) => {
    need(req.user, 'lab.templates');
    res.json({ linked: await linkLabServices(db) });
  });

  // ===== مجموعة تحاليل مريض =====
  r.get('/g/:gkey', async (req, res) => {
    need(req.user, 'lab.read');
    res.json(await groupDetail(db, req.params.gkey));
  });

  const keysOf = async (gkey, keys, statuses) => {
    const g = await groupDetail(db, gkey);
    const want = Array.isArray(keys) && keys.length ? new Set(keys) : null;
    return { g, list: g.tests.filter((t) => (!want || want.has(t.key)) && (!statuses || statuses.includes(t.status))) };
  };

  // سحب العينة: رقم عينة واحد للمجموعة
  r.post('/g/:gkey/collect', async (req, res) => {
    need(req.user, 'lab.work');
    const { list } = await keysOf(req.params.gkey, req.body?.keys, ['waiting']);
    if (!list.length) throw conflict('مفيش تحاليل مستنية السحب');
    const out = await db.tx(async (t) => {
      const acc = await t.nextNumber('lab');
      const now = new Date();
      for (const x of list) {
        const { w } = await ensureWork(t, x.key, req.user);
        if (w.Status !== 'waiting') continue;
        const test = w.TestId ? await t.one('SELECT Hours, [External] FROM LabTests WHERE Id = ?', [w.TestId]) : null;
        const hours = test ? Number(test.Hours) : 2;
        await t.run("UPDATE LabWork SET Status = 'collected', AccNo = ?, CollectedAt = ?, CollectedBy = ?, DueAt = ?, UpdatedAt = ? WHERE Id = ?",
          [acc, now, req.user.id, new Date(now.getTime() + hours * 3600e3), now, w.Id]);
      }
      await audit(t, req.user, 'lab.collect', 'LabWork', null, { now: { acc, tests: list.map((x) => x.service).join('، ') } });
      return acc;
    });
    res.json({ accNo: out, ...(await groupDetail(db, req.params.gkey)) });
  });

  // حفظ النتايج (مسودة أو نهائي)
  r.post('/g/:gkey/results', async (req, res) => {
    need(req.user, 'lab.work');
    const b = req.body || {};
    const final = !!b.final;
    const g = await groupDetail(db, req.params.gkey);
    const sex = g.patient.sex, age = g.patient.age;
    const vreq = g.verifyRequired;
    const input = Array.isArray(b.tests) ? b.tests : [];
    if (!input.length) throw bad('مفيش نتايج');
    const results = await db.tx(async (t) => {
      const done = [];
      for (const ti of input) {
        const tst = g.tests.find((x) => x.key === ti.key);
        if (!tst) throw notFound('تحليل مش في المجموعة دي');
        if (tst.status === 'waiting') throw conflict(`«${tst.service}»: العينة لسه ما اتسحبتش`);
        if (tst.status === 'delivered' && !can(req.user, 'settings.manage')) throw conflict(`«${tst.service}» اتسلّم. التعديل بعد التسليم للمدير بس`);
        if (tst.status === 'verified' && !can(req.user, 'lab.verify')) throw conflict(`«${tst.service}» اتعتمد. التعديل لدكتور المعمل`);
        const { w } = await ensureWork(t, tst.key, req.user);
        const params = w.TestId ? await t.query('SELECT * FROM LabParams WHERE TestId = ? AND Active = 1 ORDER BY SortOrder, Id', [w.TestId]) : GENERIC;
        const vals = Array.isArray(ti.values) ? ti.values : [];
        await t.run('DELETE FROM LabValues WHERE WorkId = ?', [w.Id]);
        let filled = 0, need0 = 0, i = 0;
        for (const p of params) {
          const v = vals.find((x) => (p.Id != null && Number(x.paramId) === p.Id) || (p.Id == null && x.name === p.Name));
          const value = p.Kind === 'header' ? null : str(latin(v?.value ?? ''), 200);
          if (p.Kind !== 'header') { need0++; if (value) filled++; }
          await t.insert('LabValues', { WorkId: w.Id, ParamId: p.Id, Name: p.Name, Unit: p.Unit, Value: value, Flag: p.Kind === 'header' ? null : flagFor(p, value, sex, age),
            RefText: p.Kind === 'header' ? null : refTextFor(p, sex, age), Kind: p.Kind, SortOrder: i++ });
        }
        if (final && !filled) throw bad(`«${tst.service}»: النتيجة فاضية`);
        const now = new Date();
        const comment = str(ti.comment, 500);
        if (final) {
          const already = ['verified', 'delivered'].includes(tst.status);
          const status = already ? tst.status : vreq ? 'done' : 'verified';
          await t.run(`UPDATE LabWork SET Status = ?, Comment = ?, EnteredAt = COALESCE(EnteredAt, ?), EnteredBy = COALESCE(EnteredBy, ?),
              VerifiedAt = CASE WHEN ? = 'verified' AND VerifiedAt IS NULL THEN ? ELSE VerifiedAt END, VerifiedBy = CASE WHEN ? = 'verified' AND VerifiedBy IS NULL THEN ? ELSE VerifiedBy END, UpdatedAt = ? WHERE Id = ?`,
            [status, comment, now, req.user.id, status, now, status, req.user.id, now, w.Id]);
          await audit(t, req.user, already ? 'lab.amend' : 'lab.result', 'LabWork', w.Id, { now: { acc: w.AccNo, test: tst.service, filled, of: need0 } });
        } else {
          await t.run('UPDATE LabWork SET Comment = ?, UpdatedAt = ? WHERE Id = ?', [comment, now, w.Id]);
        }
        done.push(tst.key);
      }
      return done;
    });
    res.json({ saved: results, ...(await groupDetail(db, req.params.gkey)) });
  });

  // اعتماد دكتور المعمل
  r.post('/g/:gkey/verify', async (req, res) => {
    need(req.user, 'lab.verify');
    const { list } = await keysOf(req.params.gkey, req.body?.keys, ['done']);
    if (!list.length) throw conflict('مفيش نتايج مستنية الاعتماد');
    await db.tx(async (t) => {
      for (const x of list) {
        await t.run("UPDATE LabWork SET Status = 'verified', VerifiedAt = ?, VerifiedBy = ?, UpdatedAt = ? WHERE Id = ? AND Status = 'done'", [new Date(), req.user.id, new Date(), x.workId]);
        await audit(t, req.user, 'lab.verify', 'LabWork', x.workId, { now: { acc: x.accNo, test: x.service } });
      }
    });
    res.json(await groupDetail(db, req.params.gkey));
  });

  // التسليم
  r.post('/g/:gkey/deliver', async (req, res) => {
    need(req.user, 'lab.deliver');
    const { g, list } = await keysOf(req.params.gkey, req.body?.keys, ['verified']);
    if (!list.length) throw conflict('مفيش نتايج جاهزة للتسليم');
    const to = str(req.body?.to, 150) || g.patient.name;
    await db.tx(async (t) => {
      for (const x of list) {
        await t.run("UPDATE LabWork SET Status = 'delivered', DeliveredAt = ?, DeliveredBy = ?, DeliveredTo = ?, UpdatedAt = ? WHERE Id = ? AND Status = 'verified'", [new Date(), req.user.id, to, new Date(), x.workId]);
      }
      await audit(t, req.user, 'lab.deliver', 'LabWork', null, { now: { to, tests: list.map((x) => x.service).join('، ') } });
    });
    res.json(await groupDetail(db, req.params.gkey));
  });

  // معمل خارجي: اتبعت
  r.post('/w/:key/send', async (req, res) => {
    need(req.user, 'lab.work');
    let gkey;
    await db.tx(async (t) => {
      const { w, it, src } = await ensureWork(t, req.params.key, req.user);
      gkey = groupKeyOf(src, it);
      if (!['collected', 'sent'].includes(w.Status)) throw conflict(w.Status === 'waiting' ? 'اسحب العينة الأول' : 'النتيجة اتكتبت خلاص');
      const lab = w.TestId ? await t.one('SELECT ExternalLab FROM LabTests WHERE Id = ?', [w.TestId]) : null;
      const to = str(req.body?.to, 150) || lab?.ExternalLab || null;
      const hours = Number(req.body?.hours) > 0 ? Number(req.body.hours) : 72;
      await t.run("UPDATE LabWork SET Status = 'sent', SentAt = ?, SentTo = ?, DueAt = ?, UpdatedAt = ? WHERE Id = ?", [new Date(), to, new Date(Date.now() + hours * 3600e3), new Date(), w.Id]);
      await audit(t, req.user, 'lab.send', 'LabWork', w.Id, { now: { acc: w.AccNo, to } });
    });
    res.json(await groupDetail(db, gkey));
  });

  // معمل خارجي: رفع النتيجة (PDF/صورة)
  r.post('/w/:key/file', async (req, res) => {
    need(req.user, 'lab.work');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = FILE_TYPES[type];
    if (!ext) throw bad('الملف لازم يكون PDF أو صورة');
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length < 50) throw bad('الملف فاضي');
    if (buf.length > 20 * 1024 * 1024) throw bad('الملف أكبر من 20 ميجا');
    let gkey;
    await db.tx(async (t) => {
      const { w, it, src } = await ensureWork(t, req.params.key, req.user);
      gkey = groupKeyOf(src, it);
      if (w.Status === 'waiting') throw conflict('اسحب العينة الأول');
      mkdirSync(UP_DIR, { recursive: true });
      const name = `${w.AccNo || 'x'}-${w.Id}-${Date.now()}.${ext}`;
      writeFileSync(path.join(UP_DIR, name), buf);
      const now = new Date();
      const st = ['collected', 'sent', 'done'].includes(w.Status) ? 'verified' : w.Status;
      await t.run(`UPDATE LabWork SET ExtFile = ?, ExtFileType = ?, Status = ?, EnteredAt = COALESCE(EnteredAt, ?), EnteredBy = COALESCE(EnteredBy, ?),
          VerifiedAt = COALESCE(VerifiedAt, ?), VerifiedBy = COALESCE(VerifiedBy, ?), UpdatedAt = ? WHERE Id = ?`, [name, type, st, now, req.user.id, now, req.user.id, now, w.Id]);
      await audit(t, req.user, 'lab.file', 'LabWork', w.Id, { now: { acc: w.AccNo, size: buf.length } });
    });
    res.status(201).json(await groupDetail(db, gkey));
  });
  r.get('/w/:key/file', async (req, res) => {
    need(req.user, 'lab.read');
    const m = /^([va])(\d+)$/.exec(req.params.key || '');
    if (!m) throw notFound('مش موجود');
    const w = await db.one(`SELECT * FROM LabWork WHERE Status <> 'cancelled' AND ${m[1] === 'v' ? 'VisitItemId' : 'AdmissionItemId'} = ?`, [Number(m[2])]);
    if (!w?.ExtFile) throw notFound('مفيش ملف');
    const f = path.join(UP_DIR, path.basename(w.ExtFile));
    if (!existsSync(f)) throw notFound('الملف مش موجود على السيرفر');
    res.setHeader('Content-Type', w.ExtFileType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="lab-${w.AccNo || w.Id}.${path.extname(f).slice(1)}"`);
    res.end(readFileSync(f));
  });

  // رجوع خطوة
  r.post('/w/:key/undo', async (req, res) => {
    need(req.user, 'lab.work');
    const reason = str(req.body?.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب السبب');
    let gkey;
    await db.tx(async (t) => {
      const { w, it, src } = await ensureWork(t, req.params.key, req.user);
      gkey = groupKeyOf(src, it);
      const back = { collected: 'waiting', sent: 'collected', done: w.SentAt ? 'sent' : 'collected', verified: req.user.role === 'lab' || can(req.user, 'lab.verify') ? (w.EnteredAt && !w.ExtFile ? 'done' : w.SentAt ? 'sent' : 'collected') : null, delivered: 'verified' }[w.Status];
      if (!back) throw conflict('مفيش خطوة ترجعلها');
      await t.run(`UPDATE LabWork SET Status = ?, UpdatedAt = ?,
          AccNo = CASE WHEN ? = 'waiting' THEN NULL ELSE AccNo END, CollectedAt = CASE WHEN ? = 'waiting' THEN NULL ELSE CollectedAt END,
          VerifiedAt = CASE WHEN ? IN ('verified','delivered') THEN VerifiedAt ELSE NULL END, VerifiedBy = CASE WHEN ? IN ('verified','delivered') THEN VerifiedBy ELSE NULL END,
          DeliveredAt = CASE WHEN ? = 'delivered' THEN NULL ELSE DeliveredAt END, DeliveredTo = CASE WHEN ? = 'delivered' THEN NULL ELSE DeliveredTo END
         WHERE Id = ?`, [back, new Date(), back, back, back, back, w.Status, w.Status, w.Id]);
      await audit(t, req.user, 'lab.undo', 'LabWork', w.Id, { old: w.Status, now: back, note: reason });
    });
    res.json(await groupDetail(db, gkey));
  });

  return r;
}

/** عدادات المعمل للقايمة الجانبية */
export async function labCounts(db) {
  const idx = await testsIndex(db);
  const rows = (await loadItems(db, { since: new Date(Date.now() - 21 * 24 * 3600e3) })).map((x) => testRow(x, idx));
  const c = { waiting: 0, inlab: 0, ready: 0, overdue: 0 };
  for (const x of rows) { if (c[x.group] != null) c[x.group]++; if (x.overdue) c.overdue++; }
  return c;
}
export { groupDetail as labGroupDetail };
