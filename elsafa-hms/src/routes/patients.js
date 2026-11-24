// ملف المريض: البحث والتسجيل والتعديل
import { router } from '../lib/router.js';
import { searchKey, onlyDigits, normalizePhone, isValidPhone, cleanName, nameParts } from '../../shared/text.js';
import { parseNationalId, ageText } from '../../shared/nid.js';
import { need, audit } from '../lib/auth.js';
import { bad, conflict, notFound, intId, str, cents, pounds } from '../lib/util.js';
import { R } from '../lib/runtime.js';
import { toBool, toIso, toDateStr } from '../db/index.js';
import { enqueueUpdate, flushOutbox } from '../lib/peer.js';

export function patientDto(r) {
  if (!r) return null;
  const birthDate = toDateStr(r.BirthDate);
  return {
    id: r.Id,
    no: r.PatientNo,
    name: r.FullName,
    phone: r.Phone,
    birthDate,
    ageYears: r.AgeYears,
    ageRecordedAt: toIso(r.AgeRecordedAt),
    age: ageText(birthDate, r.AgeYears, r.AgeRecordedAt),
    sex: r.Sex,
    nationalId: r.NationalId,
    address: r.Address,
    emergencyName: r.EmergencyName,
    emergencyPhone: r.EmergencyPhone,
    notes: r.Notes,
    incomplete: toBool(r.Incomplete),
    createdAt: toIso(r.CreatedAt),
    linked: !!r.GlobalId,
  };
}

const FIELDS = {
  FullName: 'الاسم', Phone: 'التليفون', BirthDate: 'تاريخ الميلاد', AgeYears: 'السن', Sex: 'النوع',
  NationalId: 'الرقم القومي', Address: 'العنوان', EmergencyName: 'اسم القريب', EmergencyPhone: 'تليفون القريب',
  Notes: 'ملاحظات', Incomplete: 'بيانات ناقصة', Payer: 'التعاقد',
};

/**
 * التحقق من بيانات المريض.
 * mode: 'outpatient' (العادي) | 'quick' (طوارئ بالاسم بس)
 */
const WORDS_NAME = { 2: 'ثنائي', 3: 'ثلاثي', 4: 'رباعي' };
/** مطلوب إيه من بيانات المريض في السياق ده (العيادات/الطوارئ) حسب الإعدادات */
const rulesOf = (mode) => R.patientFields[mode === 'quick' ? 'er' : 'clinic'];

function validate(body, mode) {
  const errors = {};
  const rules = rulesOf(mode);
  const name = cleanName(body.name);
  if (!name) errors.name = 'اكتب اسم المريض';
  else if (nameParts(name) < rules.words) errors.name = `الاسم لازم يكون ${WORDS_NAME[rules.words]} على الأقل`;

  let phone = null;
  if (body.phone) {
    phone = normalizePhone(body.phone);
    if (!isValidPhone(phone)) errors.phone = 'رقم التليفون مش صحيح';
  } else if (rules.phone === 'req') errors.phone = 'اكتب رقم التليفون';

  let nationalId = null, birthDate = null, sex = body.sex || null;
  if (!body.nationalId && rules.nid === 'req') errors.nationalId = 'اكتب الرقم القومي';
  if (body.nationalId) {
    const p = parseNationalId(body.nationalId);
    if (!p.ok) errors.nationalId = p.error;
    else {
      nationalId = p.value;
      birthDate = p.birthDate;
      sex = p.sex; // الرقم القومي هو المرجع
    }
  }
  if (!birthDate && body.birthDate) {
    const d = String(body.birthDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d)) || new Date(d) > new Date()) errors.birthDate = 'تاريخ الميلاد مش صحيح';
    else birthDate = d;
  }
  let ageYears = null;
  if (!birthDate && body.ageYears !== '' && body.ageYears != null) {
    const a = Number(onlyDigits(body.ageYears));
    if (!Number.isInteger(a) || a < 0 || a > 120) errors.ageYears = 'السن مش صحيح';
    else ageYears = a;
  }
  if (rules.age === 'req' && !birthDate && ageYears == null) errors.ageYears = 'اكتب السن أو تاريخ الميلاد';
  if (sex && !['M', 'F'].includes(sex)) errors.sex = 'اختار النوع';
  if (rules.sex === 'req' && !sex) errors.sex = 'اختار النوع';

  let emergencyPhone = null;
  if (body.emergencyPhone) {
    emergencyPhone = normalizePhone(body.emergencyPhone);
    if (!isValidPhone(emergencyPhone)) errors.emergencyPhone = 'رقم التليفون مش صحيح';
  }
  if (Object.keys(errors).length) throw bad('راجع البيانات المعلّمة', { errors });
  return {
    FullName: name, SearchKey: searchKey(name), Phone: phone, BirthDate: birthDate, AgeYears: ageYears, Sex: sex,
    NationalId: nationalId, Address: str(body.address, 250), EmergencyName: str(body.emergencyName, 120),
    EmergencyPhone: emergencyPhone, Notes: str(body.notes, 500),
  };
}

async function duplicates(db, { Phone, NationalId }, exceptId = 0) {
  const out = { byNationalId: null, byPhone: [] };
  if (NationalId) {
    const r = await db.one('SELECT Id, PatientNo, FullName FROM Patients WHERE NationalId = ? AND Id <> ?', [NationalId, exceptId]);
    if (r) out.byNationalId = { id: r.Id, no: r.PatientNo, name: r.FullName };
  }
  if (Phone) {
    const rows = await db.query(db.top('SELECT Id, PatientNo, FullName FROM Patients WHERE Phone = ? AND Id <> ? ORDER BY Id DESC', 5), [Phone, exceptId]);
    out.byPhone = rows.map((r) => ({ id: r.Id, no: r.PatientNo, name: r.FullName }));
  }
  return out;
}

/** المبالغ المتبقية على مريض (بنود مش مدفوعة في زيارات مفتوحة) */
async function balances(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT v.PatientId, SUM(i.PatientAmount) AS Due
       FROM VisitItems i JOIN Visits v ON v.Id = i.VisitId
      WHERE i.Status = 'active' AND i.PaidReceiptId IS NULL AND v.PatientId IN (${ids.map(() => '?').join(',')})
      GROUP BY v.PatientId`, ids);
  return new Map(rows.map((r) => [r.PatientId, cents(r.Due)]));
}

export async function createPatient(t, user, data, { quick = false } = {}) {
  const no = await t.nextNumber('patient');
  const now = new Date();
  const id = await t.insert('Patients', {
    PatientNo: no, ...data, AgeRecordedAt: data.AgeYears != null ? now : null,
    Incomplete: quick ? 1 : 0, CreatedAt: now, CreatedBy: user.id,
  });
  await audit(t, user, 'patient.create', 'Patient', id, { now: { no, name: data.FullName } });
  return id;
}

async function patientPayer(db, p) {
  if (!p.PayerId) return null;
  const r = await db.one('SELECT py.Name, py.Active, py.ValidTo, t.Name AS TierName FROM Payers py JOIN PayerTiers t ON t.Id = ? WHERE py.Id = ?', [p.TierId, p.PayerId]);
  if (!r) return null;
  const to = toDateStr(r.ValidTo);
  return { id: p.PayerId, name: r.Name, tierId: p.TierId, tierName: r.TierName, cardNo: p.CardNo, expired: !toBool(r.Active) || (to && to < new Date().toISOString().slice(0, 10)) };
}

async function activeAdmission(db, patientId) {
  const a = await db.one(
    `SELECT a.Id, a.AdmissionNo, a.Type, a.AdmittedAt, b.Label, r.Number AS RoomNo FROM Admissions a
       JOIN Beds b ON b.Id = a.BedId JOIN Rooms r ON r.Id = b.RoomId WHERE a.PatientId = ? AND a.Status = 'active'`, [patientId]);
  return a ? { id: a.Id, no: a.AdmissionNo, type: a.Type, admittedAt: toIso(a.AdmittedAt), bed: a.Label, room: a.RoomNo } : null;
}

export default function patientsRouter(db) {
  const r = router();

  r.get('/search', async (req, res) => {
    need(req.user, 'patients.read');
    const raw = String(req.query.q || '').trim();
    const q = searchKey(raw);
    if (!q) return res.json({ results: [] });
    const digits = onlyDigits(raw);
    let rows;
    if (digits && digits === q.replace(/\s/g, '')) {
      // بحث بالأرقام: رقم ملف، تليفون، رقم قومي
      const where = [];
      const params = [];
      if (digits.length <= 8) { where.push('PatientNo = ?'); params.push(Number(digits)); }
      if (digits.length >= 4) { where.push('Phone LIKE ?'); params.push('%' + digits + '%'); }
      if (digits.length >= 6) { where.push('NationalId LIKE ?'); params.push(digits + '%'); }
      if (!where.length) return res.json({ results: [] });
      rows = await db.query(db.top(`SELECT * FROM Patients WHERE ${where.join(' OR ')} ORDER BY Id DESC`, 30), params);
      rows.sort((a, b) => (String(b.PatientNo) === digits) - (String(a.PatientNo) === digits));
    } else {
      const words = q.split(' ').filter(Boolean).slice(0, 5);
      rows = await db.query(db.top(
        `SELECT * FROM Patients WHERE ${words.map(() => 'SearchKey LIKE ?').join(' AND ')} ORDER BY Id DESC`, 30),
      words.map((w) => '%' + w + '%'));
      // اللي اسمه بيبدأ بالكلمة الأولى يطلع الأول
      rows.sort((a, b) => b.SearchKey.startsWith(words[0]) - a.SearchKey.startsWith(words[0]));
    }
    const due = await balances(db, rows.map((x) => x.Id));
    const ids = rows.map((x) => x.Id);
    const adm = ids.length ? await db.query(`SELECT PatientId, Id FROM Admissions WHERE Status = 'active' AND PatientId IN (${ids.map(() => '?').join(',')})`, ids) : [];
    const admMap = new Map(adm.map((a) => [a.PatientId, a.Id]));
    res.json({ results: rows.map((x) => ({ ...patientDto(x), due: pounds(due.get(x.Id) || 0), admissionId: admMap.get(x.Id) || null })) });
  });

  r.post('/check', async (req, res) => {
    need(req.user, 'patients.read');
    const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
    const nid = req.body.nationalId ? onlyDigits(req.body.nationalId) : null;
    res.json(await duplicates(db, { Phone: phone, NationalId: nid && nid.length === 14 ? nid : null }, Number(req.body.exceptId) || 0));
  });

  r.post('/', async (req, res) => {
    need(req.user, 'patients.write');
    const quick = req.body.mode === 'quick';
    const data = validate(req.body, quick ? 'quick' : 'outpatient');
    const dup = await duplicates(db, data);
    if (dup.byNationalId) throw conflict(`الرقم القومي ده متسجل لملف رقم ${dup.byNationalId.no} (${dup.byNationalId.name})`, { duplicate: dup });
    if (dup.byPhone.length && !req.body.confirmDuplicatePhone) {
      throw conflict('رقم التليفون ده متسجل لمريض تاني', { duplicate: dup, needsConfirm: true });
    }
    const id = await db.tx((t) => createPatient(t, req.user, data, { quick }));
    res.status(201).json({ patient: patientDto(await db.one('SELECT * FROM Patients WHERE Id = ?', [id])) });
  });

  r.get('/:id', async (req, res) => {
    need(req.user, 'patients.read');
    const id = intId(req.params.id);
    const p = await db.one('SELECT * FROM Patients WHERE Id = ?', [id]);
    if (!p) throw notFound('الملف ده مش موجود');
    const visits = await db.query(db.top(
      `SELECT v.Id, v.VisitNo, v.Type, v.Status, v.OpenedAt,
              (SELECT SUM(Amount) FROM VisitItems WHERE VisitId = v.Id AND Status = 'active') AS Total,
              (SELECT SUM(PatientAmount) FROM VisitItems WHERE VisitId = v.Id AND Status = 'active' AND PaidReceiptId IS NULL) AS Due,
              (SELECT COUNT(*) FROM VisitItems WHERE VisitId = v.Id AND Status = 'active') AS Items
         FROM Visits v WHERE v.PatientId = ? ORDER BY v.Id DESC`, 15), [id]);
    const edits = await db.query(db.top(
      `SELECT e.At, e.Field, e.OldValue, e.NewValue, u.FullName AS UserName
         FROM PatientEdits e JOIN Users u ON u.Id = e.UserId WHERE e.PatientId = ? ORDER BY e.Id DESC`, 20), [id]);
    const due = visits.reduce((s, v) => s + cents(v.Due), 0);
    res.json({
      patient: patientDto(p),
      due: pounds(due),
      admittedNow: await activeAdmission(db, id),
      payer: await patientPayer(db, p),
      admissions: (await db.query(db.top(
        `SELECT a.Id, a.AdmissionNo, a.Type, a.Status, a.AdmittedAt, a.DischargedAt,
                (SELECT COUNT(*) FROM AdmissionItems WHERE AdmissionId = a.Id AND Status = 'active' AND Kind = 'night') AS Nights
           FROM Admissions a WHERE a.PatientId = ? ORDER BY a.Id DESC`, 10), [id])).map((a) => ({
        id: a.Id, no: a.AdmissionNo, type: a.Type, status: a.Status, admittedAt: toIso(a.AdmittedAt), dischargedAt: toIso(a.DischargedAt), nights: Number(a.Nights),
      })),
      visits: visits.map((v) => ({
        id: v.Id, no: v.VisitNo, type: v.Type, status: v.Status, openedAt: toIso(v.OpenedAt),
        total: pounds(cents(v.Total)), due: pounds(cents(v.Due)), items: Number(v.Items),
      })),
      edits: edits.map((e) => ({ at: toIso(e.At), field: FIELDS[e.Field] || e.Field, old: e.OldValue, new: e.NewValue, by: e.UserName })),
    });
  });

  // تعاقد المريض الافتراضي (بيتحط لوحده في الزيارات والدخول الجديدة)
  r.put('/:id/payer', async (req, res) => {
    need(req.user, 'patients.write');
    const id = intId(req.params.id);
    const p = await db.one('SELECT * FROM Patients WHERE Id = ?', [id]);
    if (!p) throw notFound('الملف ده مش موجود');
    const b = req.body || {};
    await db.tx(async (t) => {
      if (b.payerId) {
        const { loadPayer } = await import('../lib/coverage.js');
        await loadPayer(t, b.payerId, b.tierId);
        if (!str(b.cardNo, 60)) throw bad('اكتب رقم الكارنيه', { errors: { cardNo: 'اكتب رقم الكارنيه' } });
      }
      await t.run('UPDATE Patients SET PayerId = ?, TierId = ?, CardNo = ? WHERE Id = ?', [b.payerId ? Number(b.payerId) : null, b.payerId ? Number(b.tierId) : null, b.payerId ? str(b.cardNo, 60) : null, id]);
      await t.insert('PatientEdits', { PatientId: id, At: new Date(), UserId: req.user.id, Field: 'Payer', OldValue: p.PayerId ? `${p.PayerId}/${p.TierId}/${p.CardNo}` : null, NewValue: b.payerId ? `${b.payerId}/${b.tierId}/${b.cardNo}` : null });
    });
    res.json({ payer: await patientPayer(db, await db.one('SELECT * FROM Patients WHERE Id = ?', [id])) });
  });

  r.put('/:id', async (req, res) => {
    need(req.user, 'patients.write');
    const id = intId(req.params.id);
    const old = await db.one('SELECT * FROM Patients WHERE Id = ?', [id]);
    if (!old) throw notFound('الملف ده مش موجود');
    const data = validate(req.body, 'outpatient');
    const dup = await duplicates(db, data, id);
    if (dup.byNationalId) throw conflict(`الرقم القومي ده متسجل لملف رقم ${dup.byNationalId.no} (${dup.byNationalId.name})`, { duplicate: dup });
    data.Incomplete = 0;
    const changes = [];
    for (const k of Object.keys(FIELDS)) {
      if (!(k in data)) continue;
      const a = k === 'BirthDate' ? toDateStr(old[k]) : old[k] == null ? null : k === 'Incomplete' ? (toBool(old[k]) ? 1 : 0) : old[k];
      const b = data[k];
      if (String(a ?? '') !== String(b ?? '')) changes.push({ k, a, b });
    }
    if (!changes.length) return res.json({ patient: patientDto(old), changed: 0 });
    await db.tx(async (t) => {
      const now = new Date();
      const sets = changes.map((c) => `${c.k} = ?`);
      const vals = changes.map((c) => c.b);
      if (changes.some((c) => c.k === 'FullName')) { sets.push('SearchKey = ?'); vals.push(data.SearchKey); }
      if (changes.some((c) => c.k === 'AgeYears')) { sets.push('AgeRecordedAt = ?'); vals.push(data.AgeYears != null ? now : null); }
      sets.push('UpdatedAt = ?', 'UpdatedBy = ?');
      await t.run(`UPDATE Patients SET ${sets.join(', ')} WHERE Id = ?`, [...vals, now, req.user.id, id]);
      if (old.GlobalId && changes.some((c) => c.k in FIELDS && c.k !== 'Incomplete' && c.k !== 'Payer')) await enqueueUpdate(t, { ...old, ...Object.fromEntries(changes.map((c) => [c.k, c.b])), SearchKey: data.SearchKey, UpdatedAt: now });
      for (const c of changes) {
        if (c.k === 'Incomplete') continue;
        await t.insert('PatientEdits', {
          PatientId: id, At: now, UserId: req.user.id, Field: c.k,
          OldValue: c.a == null ? null : String(c.a).slice(0, 500), NewValue: c.b == null ? null : String(c.b).slice(0, 500),
        });
      }
    });
    if (old.GlobalId) flushOutbox(db).catch(() => {}); // بنبعت للمنشأة التانية بدون ما نعطّل الحفظ
    res.json({ patient: patientDto(await db.one('SELECT * FROM Patients WHERE Id = ?', [id])), changed: changes.length });
  });

  return r;
}
