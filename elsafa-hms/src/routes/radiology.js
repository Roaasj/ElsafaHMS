// قسم الأشعة: قايمة الشغل من الخدمات المدفوعة/الإقامة، التقارير بالقوالب، المقطعية برة، والتسليم
import { deptSql } from '../lib/lookups.js';
import { R } from '../lib/runtime.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, intId, str } from '../lib/util.js';
import { toIso, toBool, toDateStr } from '../db/index.js';
import { ROOT } from '../config.js';

export const MODS = { us: 'سونار', ct: 'مقطعية', mri: 'رنين', xray: 'عادية', mammo: 'ماموجرام', other: 'أخرى' };
const EXTERNAL = ['ct', 'mri'];            // بتتبعت لدكتور برة
const NO_REPORT_NEEDED = ['xray'];         // ممكن تتسلم من غير تقرير
const UP_DIR = path.join(ROOT, 'data', 'uploads', 'radiology');
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** نوع الجهاز من الخدمة (المدير يقدر يحدده، وإلا من الاسم) */
export function modalityOf(name, mod) {
  if (mod && MODS[mod]) return mod;
  const n = String(name || '');
  if (/سونار|دوبلر|إيكو|ايكو|ultra|doppler|echo/i.test(n)) return 'us';
  if (/مقطع|\bCT\b/i.test(n)) return 'ct';
  if (/رنين|MRI/i.test(n)) return 'mri';
  if (/ماموج|mammo/i.test(n)) return 'mammo';
  if (/عادية|x-?ray|أشعة/i.test(n)) return 'xray';
  return 'other';
}

/** HTML آمن: وسوم بسيطة بس ومن غير أي خصائص غير الاتجاه */
const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'h3', 'h4', 'div', 'span']);
export function cleanHtml(html) {
  let s = String(html || '').slice(0, 200000);
  s = s.replace(/<(script|style|iframe|object|embed|svg|math|template)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g, (m, close, tag, attrs = '') => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return '';
    if (close) return t === 'br' ? '' : `</${t}>`;
    const dir = /\bdir\s*=\s*["']?(rtl|ltr|auto)/i.exec(attrs);
    return `<${t}${dir ? ` dir="${dir[1].toLowerCase()}"` : ''}>`;
  });
  // أي «<» فاضل من غير وسم مسموح بيتحول لنص
  return s.replace(/<(?!\/?(?:p|br|b|strong|i|em|u|ul|ol|li|h3|h4|div|span)(?:\s[^<>]*)?>)/gi, '&lt;').trim();
}

const parseKey = (k) => {
  const m = /^([va])(\d+)$/.exec(String(k || ''));
  if (!m) throw notFound('الفحص مش موجود');
  return { src: m[1], itemId: Number(m[2]) };
};

async function dueHours(db) {
  const r = await db.one("SELECT Value FROM AppSettings WHERE [Key] = 'radDue'");
  try { return { us: 2, xray: 1, ct: 24, mri: 48, mammo: 24, other: 24, ...JSON.parse(r?.Value || '{}') }; } catch { return { us: 2, xray: 1, ct: 24, mri: 48, mammo: 24, other: 24 }; }
}

const ITEM_SQL = {
  v: `SELECT i.Id AS ItemId, i.ServiceId, i.ServiceName AS Name, i.AddedAt, i.DoctorId, d.Name AS DoctorName, i.PaidReceiptId, i.PayTiming, i.Status AS ItemStatus,
        v.PatientId, v.Id AS VisitId, v.VisitNo, NULL AS AdmissionId, NULL AS AdmissionNo, NULL AS BedLabel, NULL AS RoomNo, sv.Modality AS SvcMod
      FROM VisitItems i JOIN Visits v ON v.Id = i.VisitId LEFT JOIN Doctors d ON d.Id = i.DoctorId LEFT JOIN Services sv ON sv.Id = i.ServiceId`,
  a: `SELECT i.Id AS ItemId, i.ServiceId, i.Name AS Name, i.AddedAt, i.DoctorId, d.Name AS DoctorName, NULL AS PaidReceiptId, 'after' AS PayTiming, i.Status AS ItemStatus,
        a.PatientId, NULL AS VisitId, NULL AS VisitNo, a.Id AS AdmissionId, a.AdmissionNo, b.Label AS BedLabel, rm.Number AS RoomNo, sv.Modality AS SvcMod
      FROM AdmissionItems i JOIN Admissions a ON a.Id = i.AdmissionId LEFT JOIN Doctors d ON d.Id = i.DoctorId LEFT JOIN Services sv ON sv.Id = i.ServiceId
      LEFT JOIN Beds b ON b.Id = a.BedId LEFT JOIN Rooms rm ON rm.Id = b.RoomId`,
};
const STUDY_SQL = `SELECT s.*, u1.FullName AS DoneByName, u2.FullName AS ReportedByName, u3.FullName AS DeliveredByName
  FROM RadStudies s LEFT JOIN Users u1 ON u1.Id = s.DoneBy LEFT JOIN Users u2 ON u2.Id = s.ReportedBy LEFT JOIN Users u3 ON u3.Id = s.DeliveredBy`;

function group(st, mod) {
  if (st === 'waiting') return 'waiting';
  if (st === 'delivered') return 'delivered';
  if (st === 'reported' || (st === 'done' && NO_REPORT_NEEDED.includes(mod))) return 'ready';
  return 'report';
}

function rowDto(src, it, s, p, now = Date.now()) {
  const mod = s?.Modality || modalityOf(it.Name, it.SvcMod);
  const st = s?.Status || 'waiting';
  const due = s?.DueAt ? new Date(s.DueAt).getTime() : null;
  return {
    key: `${src}${it.ItemId}`, studyId: s?.Id || null, studyNo: s?.StudyNo || null,
    service: it.Name, modality: mod, modName: MODS[mod], status: st, group: group(st, mod), external: EXTERNAL.includes(mod),
    needsReport: !NO_REPORT_NEEDED.includes(mod),
    patient: { id: it.PatientId, name: p?.FullName, no: p?.PatientNo, sex: p?.Sex, ageYears: p?.AgeYears, birthDate: toDateStr(p?.BirthDate), phone: p?.Phone },
    requestedAt: toIso(it.AddedAt), doctor: it.DoctorName || null,
    visitId: it.VisitId, visitNo: it.VisitNo, admissionId: it.AdmissionId, admissionNo: it.AdmissionNo, bed: it.BedLabel ? `${it.RoomNo}/${it.BedLabel}` : null,
    paid: src === 'a' || it.PaidReceiptId != null,
    doneAt: toIso(s?.DoneAt), doneBy: s?.DoneByName || null, sentAt: toIso(s?.SentAt), sentTo: s?.SentTo || null,
    dueAt: toIso(s?.DueAt), overdue: ['done', 'sent'].includes(st) && due != null && due < now && !NO_REPORT_NEEDED.includes(mod),
    reportedAt: toIso(s?.ReportedAt), reportedBy: s?.ReportedByName || null, radiologist: s?.Radiologist || null,
    hasReport: !!(s?.ReportHtml), hasFile: !!(s?.ReportFile), link: s?.ReportLink || null, draft: !!(s?.ReportHtml) && st !== 'reported' && st !== 'delivered',
    deliveredAt: toIso(s?.DeliveredAt), deliveredTo: s?.DeliveredTo || null, deliveredBy: s?.DeliveredByName || null,
    notes: s?.Notes || null, clinicalInfo: s?.ClinicalInfo || null,
  };
}

async function patientsMap(db, ids) {
  const u = [...new Set(ids)].filter(Boolean);
  if (!u.length) return new Map();
  const rows = await db.query(`SELECT Id, FullName, PatientNo, Sex, AgeYears, BirthDate, Phone FROM Patients WHERE Id IN (${u.map(() => '?').join(',')})`, u);
  return new Map(rows.map((r) => [r.Id, r]));
}

/** كل فحوصات الأشعة (من غير ما نعمل سطور لحد ما القسم يشتغل) */
async function loadRows(db, { patientId = null, since = null } = {}) {
  const w = (al) => `WHERE i.Dept IN ${deptSql('radiology')} AND i.Status = 'active' ${patientId ? `AND ${al}.PatientId = ?` : ''} ${since ? 'AND i.AddedAt >= ?' : ''}`;
  const prm = [patientId, since].filter((x) => x != null);
  const vis = await db.query(`${ITEM_SQL.v} ${w('v')} AND (i.PaidReceiptId IS NOT NULL OR i.PayTiming = 'after')`, prm);
  const adm = await db.query(`${ITEM_SQL.a} ${w('a')}`, prm);
  const vIds = vis.map((x) => x.ItemId), aIds = adm.map((x) => x.ItemId);
  const studies = [];
  if (vIds.length) studies.push(...await db.query(`${STUDY_SQL} WHERE s.Status <> 'cancelled' AND s.VisitItemId IN (${vIds.map(() => '?').join(',')})`, vIds));
  if (aIds.length) studies.push(...await db.query(`${STUDY_SQL} WHERE s.Status <> 'cancelled' AND s.AdmissionItemId IN (${aIds.map(() => '?').join(',')})`, aIds));
  const sv = new Map(studies.filter((s) => s.VisitItemId).map((s) => [s.VisitItemId, s]));
  const sa = new Map(studies.filter((s) => s.AdmissionItemId).map((s) => [s.AdmissionItemId, s]));
  const pm = await patientsMap(db, [...vis, ...adm].map((x) => x.PatientId));
  const now = Date.now();
  return [
    ...vis.map((it) => rowDto('v', it, sv.get(it.ItemId), pm.get(it.PatientId), now)),
    ...adm.map((it) => rowDto('a', it, sa.get(it.ItemId), pm.get(it.PatientId), now)),
  ];
}

async function loadOne(db, key) {
  const { src, itemId } = parseKey(key);
  const it = await db.one(`${ITEM_SQL[src]} WHERE i.Id = ? AND i.Dept IN ${deptSql('radiology')}`, [itemId]);
  if (!it) throw notFound('الفحص مش موجود');
  const s = await db.one(`${STUDY_SQL} WHERE s.Status <> 'cancelled' AND s.${src === 'v' ? 'VisitItemId' : 'AdmissionItemId'} = ?`, [itemId]);
  const pm = await patientsMap(db, [it.PatientId]);
  return { src, itemId, it, s, row: rowDto(src, it, s, pm.get(it.PatientId)) };
}

/** سطر الفحص (بيتعمل أول مرة القسم يلمسه) */
async function ensureStudy(t, key, user) {
  const { src, itemId, it, s } = await loadOne(t, key);
  if (it.ItemStatus !== 'active') throw conflict('الخدمة دي اتلغت');
  if (src === 'v' && it.PaidReceiptId == null && it.PayTiming !== 'after') throw conflict('الخدمة دي لسه ما اتدفعتش');
  if (s) return s;
  const no = await t.nextNumber('study');
  const id = await t.insert('RadStudies', {
    StudyNo: no, PatientId: it.PatientId, VisitItemId: src === 'v' ? itemId : null, AdmissionItemId: src === 'a' ? itemId : null,
    ServiceName: it.Name, Modality: modalityOf(it.Name, it.SvcMod), Status: 'waiting', CreatedAt: new Date(),
  });
  await audit(t, user, 'rad.create', 'RadStudy', id, { now: { no, service: it.Name } });
  return t.one('SELECT * FROM RadStudies WHERE Id = ?', [id]);
}

function templateDto(t) {
  return { id: t.Id, name: t.Name, modality: t.Modality, modName: MODS[t.Modality], title: t.Title, body: t.Body, sort: Number(t.SortOrder || 0), active: toBool(t.Active) };
}

export default function radiologyRouter(db) {
  const r = router();

  // قايمة الشغل
  r.get('/', async (req, res) => {
    need(req.user, 'rad.read');
    const since = new Date(Date.now() - 21 * 24 * 3600e3);
    let rows = await loadRows(db, { since });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toLocaleDateString('en-CA', { timeZone: R.tz });
    const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: R.tz }) : null);
    // المتسلّم بيظهر بيوم التسليم بس
    rows = rows.filter((x) => x.group !== 'delivered' || dayOf(x.deliveredAt) === date);
    const counts = { waiting: 0, report: 0, ready: 0, delivered: 0, overdue: 0 };
    for (const x of rows) { counts[x.group]++; if (x.overdue) counts.overdue++; }
    const g = ['waiting', 'report', 'ready', 'delivered', 'all'].includes(req.query.group) ? req.query.group : 'waiting';
    const mod = MODS[req.query.mod] ? req.query.mod : null;
    let list = rows.filter((x) => (g === 'all' || x.group === g) && (!mod || x.modality === mod));
    const q = String(req.query.q || '').trim();
    if (q) list = list.filter((x) => x.patient.name?.includes(q) || String(x.patient.no) === q || String(x.studyNo) === q || x.service.includes(q));
    list.sort((a, b) => (b.overdue - a.overdue) || (g === 'delivered' ? (b.deliveredAt || '').localeCompare(a.deliveredAt || '') : (a.requestedAt || '').localeCompare(b.requestedAt || '')));
    const byMod = {};
    for (const x of rows.filter((x) => g === 'all' || x.group === g)) byMod[x.modality] = (byMod[x.modality] || 0) + 1;
    res.json({ rows: list, counts, byMod, mods: MODS, date });
  });

  r.get('/patient/:id', async (req, res) => {
    need(req.user, 'rad.read');
    const rows = await loadRows(db, { patientId: intId(req.params.id) });
    rows.sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
    res.json({ rows: rows.slice(0, 30) });
  });

  // القوالب
  r.get('/templates', async (req, res) => {
    need(req.user, 'rad.read');
    const all = req.query.all === '1' && can(req.user, 'rad.templates');
    const rows = await db.query(`SELECT * FROM RadTemplates ${all ? '' : 'WHERE Active = 1'} ORDER BY SortOrder, Id`);
    res.json({ templates: rows.map(templateDto), mods: MODS });
  });
  const tplBody = (b) => {
    const errors = {};
    const name = str(b.name, 120);
    if (!name) errors.name = 'اكتب اسم القالب';
    if (!MODS[b.modality]) errors.modality = 'اختار النوع';
    const body = cleanHtml(b.body);
    if (!body) errors.body = 'القالب فاضي';
    if (Object.keys(errors).length) throw bad('راجع البيانات', { errors });
    return { Name: name, Modality: b.modality, Title: str(b.title, 200), Body: body, SortOrder: Number(b.sort) || 0, Active: b.active === false ? 0 : 1 };
  };
  r.post('/templates', async (req, res) => {
    need(req.user, 'rad.templates');
    const row = tplBody(req.body || {});
    const id = await db.tx(async (t) => {
      const x = await t.insert('RadTemplates', { ...row, CreatedAt: new Date(), UpdatedAt: new Date(), UpdatedBy: req.user.id });
      await audit(t, req.user, 'rad.template', 'RadTemplate', x, { now: { name: row.Name } });
      return x;
    });
    res.status(201).json({ template: templateDto(await db.one('SELECT * FROM RadTemplates WHERE Id = ?', [id])) });
  });
  r.put('/templates/:id', async (req, res) => {
    need(req.user, 'rad.templates');
    const id = intId(req.params.id);
    const row = tplBody(req.body || {});
    await db.tx(async (t) => {
      if (!await t.one('SELECT Id FROM RadTemplates WHERE Id = ?', [id])) throw notFound('القالب مش موجود');
      await t.run('UPDATE RadTemplates SET Name = ?, Modality = ?, Title = ?, Body = ?, SortOrder = ?, Active = ?, UpdatedAt = ?, UpdatedBy = ? WHERE Id = ?',
        [row.Name, row.Modality, row.Title, row.Body, row.SortOrder, row.Active, new Date(), req.user.id, id]);
      await audit(t, req.user, 'rad.template', 'RadTemplate', id, { now: { name: row.Name } });
    });
    res.json({ template: templateDto(await db.one('SELECT * FROM RadTemplates WHERE Id = ?', [id])) });
  });

  // فحص واحد
  r.get('/:key', async (req, res) => {
    need(req.user, 'rad.read');
    const { row, s } = await loadOne(db, req.params.key);
    res.json({ study: { ...row, reportTitle: s?.ReportTitle || null, reportHtml: s?.ReportHtml || null, fileType: s?.ReportFileType || null, printCount: s?.PrintCount || 0 } });
  });

  const act = (perm, fn) => async (req, res) => {
    need(req.user, perm);
    const key = req.params.key;
    await db.tx(async (t) => { const s = await ensureStudy(t, key, req.user); await fn(t, s, req.body || {}, req.user); });
    const { row, s } = await loadOne(db, key);
    res.json({ study: { ...row, reportTitle: s?.ReportTitle || null, reportHtml: s?.ReportHtml || null, fileType: s?.ReportFileType || null } });
  };

  // اتعمل الفحص
  r.post('/:key/done', act('rad.work', async (t, s, b, user) => {
    if (s.Status !== 'waiting') throw conflict('الفحص ده اتعمل قبل كده');
    const now = new Date();
    const h = (await dueHours(t))[s.Modality] ?? 24;
    await t.run("UPDATE RadStudies SET Status = 'done', DoneAt = ?, DoneBy = ?, DueAt = ?, ClinicalInfo = COALESCE(?, ClinicalInfo), Notes = COALESCE(?, Notes), UpdatedAt = ? WHERE Id = ?",
      [now, user.id, new Date(now.getTime() + h * 3600e3), str(b.clinicalInfo, 400), str(b.notes, 400), now, s.Id]);
    await audit(t, user, 'rad.done', 'RadStudy', s.Id, { now: { no: s.StudyNo } });
  }));

  // اتبعت لدكتور برة (مقطعية/رنين)
  r.post('/:key/sent', act('rad.work', async (t, s, b, user) => {
    if (!['done', 'sent'].includes(s.Status)) throw conflict(s.Status === 'waiting' ? 'سجّل إن الفحص اتعمل الأول' : 'التقرير جه خلاص');
    await t.run("UPDATE RadStudies SET Status = 'sent', SentAt = ?, SentTo = ?, UpdatedAt = ? WHERE Id = ?", [new Date(), str(b.to, 150), new Date(), s.Id]);
    await audit(t, user, 'rad.sent', 'RadStudy', s.Id, { now: { no: s.StudyNo, to: str(b.to, 150) } });
  }));

  // التقرير: حفظ مسودة أو اعتماد (final)
  r.post('/:key/report', act('rad.report', async (t, s, b, user) => {
    if (s.Status === 'waiting') throw conflict('سجّل إن الفحص اتعمل الأول');
    if (s.Status === 'delivered' && !can(user, 'settings.manage')) throw conflict('التقرير اتسلّم للمريض. التعديل بعد التسليم للمدير بس');
    const html = cleanHtml(b.html);
    const final = !!b.final;
    if (final && !html && !s.ReportFile && !str(b.link, 500) && !s.ReportLink) throw bad('اكتب التقرير الأول', { errors: { html: 'التقرير فاضي' } });
    const radiologist = str(b.radiologist, 150) || s.Radiologist || (user.role === 'radiology' ? user.name : null);
    if (final && !radiologist) throw bad('اكتب اسم دكتور الأشعة', { errors: { radiologist: 'اكتب اسم الدكتور' } });
    const now = new Date();
    const wasFinal = ['reported', 'delivered'].includes(s.Status);
    await t.run(`UPDATE RadStudies SET ReportHtml = ?, ReportTitle = ?, Radiologist = ?, ReportLink = COALESCE(?, ReportLink), UpdatedAt = ?,
        Status = ?, ReportedAt = ?, ReportedBy = ? WHERE Id = ?`,
      [html || null, str(b.title, 200), radiologist, str(b.link, 500), now,
        final && !wasFinal ? 'reported' : s.Status, final && !wasFinal ? now : s.ReportedAt, final && !wasFinal ? user.id : s.ReportedBy, s.Id]);
    await audit(t, user, wasFinal ? 'rad.amend' : final ? 'rad.report' : 'rad.draft', 'RadStudy', s.Id, { now: { no: s.StudyNo } });
  }));

  // لينك التقرير (برنامج الأشعة على الويب)
  r.post('/:key/link', act('rad.work', async (t, s, b, user) => {
    const link = str(b.link, 500);
    if (link && !/^https?:\/\//i.test(link)) throw bad('اللينك لازم يبدأ بـ http', { errors: { link: 'لينك مش صحيح' } });
    if (s.Status === 'waiting') throw conflict('سجّل إن الفحص اتعمل الأول');
    const final = !!b.final && !!link;
    await t.run(`UPDATE RadStudies SET ReportLink = ?, Radiologist = COALESCE(?, Radiologist), UpdatedAt = ?,
        Status = CASE WHEN ? = 1 AND Status IN ('done','sent') THEN 'reported' ELSE Status END,
        ReportedAt = CASE WHEN ? = 1 AND ReportedAt IS NULL THEN ? ELSE ReportedAt END,
        ReportedBy = CASE WHEN ? = 1 AND ReportedBy IS NULL THEN ? ELSE ReportedBy END WHERE Id = ?`,
      [link, str(b.radiologist, 150), new Date(), final ? 1 : 0, final ? 1 : 0, new Date(), final ? 1 : 0, user.id, s.Id]);
    await audit(t, user, 'rad.link', 'RadStudy', s.Id, { now: { no: s.StudyNo } });
  }));

  // رفع ملف التقرير (PDF/صورة) — جسم الطلب هو الملف نفسه
  r.post('/:key/file', async (req, res) => {
    need(req.user, 'rad.work');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = FILE_TYPES[type];
    if (!ext) throw bad('الملف لازم يكون PDF أو صورة');
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length < 50) throw bad('الملف فاضي');
    if (buf.length > 20 * 1024 * 1024) throw bad('الملف أكبر من 20 ميجا');
    const final = req.query.final === '1';
    const radiologist = str(req.query.radiologist, 150);
    await db.tx(async (t) => {
      const s = await ensureStudy(t, req.params.key, req.user);
      if (s.Status === 'waiting') throw conflict('سجّل إن الفحص اتعمل الأول');
      mkdirSync(UP_DIR, { recursive: true });
      const name = `${s.StudyNo}-${Date.now()}.${ext}`;
      writeFileSync(path.join(UP_DIR, name), buf);
      const now = new Date();
      const fin = final && ['done', 'sent'].includes(s.Status);
      await t.run('UPDATE RadStudies SET ReportFile = ?, ReportFileType = ?, Radiologist = COALESCE(?, Radiologist), UpdatedAt = ?, Status = ?, ReportedAt = ?, ReportedBy = ? WHERE Id = ?',
        [name, type, radiologist, now, fin ? 'reported' : s.Status, fin ? now : s.ReportedAt, fin ? req.user.id : s.ReportedBy, s.Id]);
      await audit(t, req.user, 'rad.file', 'RadStudy', s.Id, { now: { no: s.StudyNo, size: buf.length } });
    });
    const { row, s } = await loadOne(db, req.params.key);
    res.status(201).json({ study: { ...row, reportTitle: s?.ReportTitle || null, reportHtml: s?.ReportHtml || null, fileType: s?.ReportFileType || null } });
  });

  r.get('/:key/file', async (req, res) => {
    need(req.user, 'rad.read');
    const { s } = await loadOne(db, req.params.key);
    if (!s?.ReportFile) throw notFound('مفيش ملف');
    const f = path.join(UP_DIR, path.basename(s.ReportFile));
    if (!existsSync(f)) throw notFound('الملف مش موجود على السيرفر');
    res.setHeader('Content-Type', s.ReportFileType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="study-${s.StudyNo}.${path.extname(f).slice(1)}"`);
    res.end(readFileSync(f));
  });

  // التسليم للمريض
  r.post('/:key/deliver', act('rad.deliver', async (t, s, b, user) => {
    if (s.Status === 'delivered') throw conflict('اتسلّم قبل كده');
    const okNoReport = NO_REPORT_NEEDED.includes(s.Modality) && s.Status === 'done';
    if (s.Status !== 'reported' && !okNoReport) throw conflict(s.Status === 'waiting' ? 'الفحص لسه ما اتعملش' : 'التقرير لسه ما جهزش');
    const p = await t.one('SELECT FullName FROM Patients WHERE Id = ?', [s.PatientId]);
    const to = str(b.to, 150) || p.FullName;
    await t.run("UPDATE RadStudies SET Status = 'delivered', DeliveredAt = ?, DeliveredBy = ?, DeliveredTo = ?, UpdatedAt = ? WHERE Id = ?", [new Date(), user.id, to, new Date(), s.Id]);
    await audit(t, user, 'rad.deliver', 'RadStudy', s.Id, { now: { no: s.StudyNo, to } });
  }));

  // رجوع خطوة (غلطة): مثلًا اتعلّم «اتعمل» بالغلط
  r.post('/:key/undo', act('rad.work', async (t, s, b, user) => {
    const reason = str(b.reason, 300);
    if (!reason || reason.length < 3) throw bad('اكتب السبب');
    const back = { done: 'waiting', sent: 'done', reported: s.SentAt ? 'sent' : 'done', delivered: s.ReportedAt ? 'reported' : 'done' }[s.Status];
    if (!back) throw conflict('مفيش خطوة ترجعلها');
    if (s.Status === 'delivered' && !can(user, 'settings.manage') && user.role !== 'radiology') throw conflict('مش مسموح');
    await t.run(`UPDATE RadStudies SET Status = ?, UpdatedAt = ?,
        DoneAt = CASE WHEN ? = 'waiting' THEN NULL ELSE DoneAt END, DueAt = CASE WHEN ? = 'waiting' THEN NULL ELSE DueAt END,
        DeliveredAt = CASE WHEN ? = 'delivered' THEN NULL ELSE DeliveredAt END, DeliveredTo = CASE WHEN ? = 'delivered' THEN NULL ELSE DeliveredTo END
       WHERE Id = ?`, [back, new Date(), back, back, s.Status, s.Status, s.Id]);
    await audit(t, user, 'rad.undo', 'RadStudy', s.Id, { old: s.Status, now: back, note: reason });
  }));

  return r;
}

/** عدادات الأشعة للقايمة الجانبية */
export async function radCounts(db) {
  const rows = await loadRows(db, { since: new Date(Date.now() - 21 * 24 * 3600e3) });
  const c = { waiting: 0, report: 0, ready: 0, overdue: 0 };
  for (const x of rows) { if (c[x.group] != null) c[x.group]++; if (x.overdue) c.overdue++; }
  return c;
}

/** إعدادات الأشعة (المدير): الوقت المتوقع للتقرير */
export async function radSettings(db) { return dueHours(db); }
