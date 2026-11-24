// الربط مع منشأة تانية: (1) واجهة المنشأة التانية /peer (بمفتاح)، (2) واجهة الموظفين /api/peer (بجلسة وصلاحيات)
import { router } from '../lib/router.js';
import { need, can, audit, userByUsername, createSession } from '../lib/auth.js';
import { dueItems, collectAll } from '../lib/collect.js';
import { shiftLabel, businessDate } from '../lib/cashier.js';
import { mustOrder } from '../lib/cashier.js';
import { HttpError, bad, conflict, notFound, intId, str, cents, pounds, cairoDayRange, parseMoney } from '../lib/util.js';
import { getService, resolveDoctorShare, VISIT_TYPES, currentPriceSql } from './catalog.js';
import { servicePrice, cover } from '../lib/coverage.js';
import { searchKey, onlyDigits, cleanName } from '../../shared/text.js';
import { toDateStr, toIso, toBool } from '../db/index.js';
import { peerCfg, setPeer, peerCall, keyMatches, identityOf, newGlobalId, enqueueUpdate, enqueueUnlink, enqueueEvent, flushOutbox, signSwitch, verifySwitch } from '../lib/peer.js';
import { createPatient, patientDto } from './patients.js';
import { R } from '../lib/runtime.js';

const toData = (i) => ({
  FullName: cleanName(i.name) || null, SearchKey: searchKey(cleanName(i.name) || ''), Phone: str(i.phone, 20), BirthDate: i.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(i.birthDate) ? i.birthDate : null,
  AgeYears: Number.isInteger(i.ageYears) ? i.ageYears : null, Sex: ['M', 'F'].includes(i.sex) ? i.sex : null,
  NationalId: i.nationalId && /^\d{14}$/.test(String(i.nationalId)) ? String(i.nationalId) : null, Address: str(i.address, 250), EmergencyName: str(i.emergencyName, 120), EmergencyPhone: str(i.emergencyPhone, 20),
});
const FIELD_LABEL = { FullName: 'الاسم', Phone: 'التليفون', BirthDate: 'تاريخ الميلاد', AgeYears: 'السن', Sex: 'النوع', NationalId: 'الرقم القومي', Address: 'العنوان', EmergencyName: 'اسم القريب', EmergencyPhone: 'تليفون القريب' };

async function sysUser(db) {
  const u = (await db.query(db.top("SELECT Id, FullName, Role FROM Users WHERE Role = 'manager' ORDER BY Id", 1)))[0];
  return u ? { id: u.Id, name: u.FullName, role: u.Role } : null;
}

/** ===== واجهة المنشأة التانية (من غير جلسة، بمفتاح الربط) ===== */
export function peerInbound(db) {
  const r = router();
  let fails = 0;
  r.use((req, res, next) => Promise.resolve((async () => {
    const cfg = await peerCfg(db);
    if (!cfg.enabled || !cfg.key) throw new HttpError(403, 'الربط مش متفعّل');
    if (!keyMatches(req.get('x-peer-key'), cfg.key)) {
      fails++; await new Promise((ok) => setTimeout(ok, Math.min(2000, 200 * fails)));
      throw new HttpError(401, 'مفتاح الربط غلط');
    }
    fails = 0; req.peer = cfg;
  })()).then(() => next(), next));
  r.get('/ping', (req, res) => res.json({ ok: true, name: R.brand.name }));
  r.get('/patients', async (req, res) => {
    let rows = [];
    if (req.query.id) rows = await db.query('SELECT * FROM Patients WHERE Id = ?', [intId(req.query.id)]);
    else if (req.query.nid) rows = await db.query('SELECT * FROM Patients WHERE NationalId = ?', [onlyDigits(req.query.nid)]);
    else if (req.query.globalId) rows = await db.query('SELECT * FROM Patients WHERE GlobalId = ?', [String(req.query.globalId)]);
    else {
      const raw = String(req.query.q || '').trim(), digits = onlyDigits(raw);
      if (digits.length >= 4 && digits === raw.replace(/\s/g, '')) rows = await db.query(db.top('SELECT * FROM Patients WHERE Phone LIKE ? OR NationalId LIKE ? ORDER BY Id DESC', 10), ['%' + digits + '%', digits + '%']);
      else { const w = searchKey(raw).split(' ').filter(Boolean).slice(0, 5); if (w.length) rows = await db.query(db.top(`SELECT * FROM Patients WHERE ${w.map(() => 'SearchKey LIKE ?').join(' AND ')} ORDER BY Id DESC`, 10), w.map((x) => '%' + x + '%')); }
    }
    res.json({ patients: rows.map(identityOf) });
  });
  r.post('/link', async (req, res) => {
    const id = intId(req.body.id), gid = String(req.body.globalId || '');
    if (!gid) throw bad('الرقم العالمي ناقص');
    const p = await db.one('SELECT * FROM Patients WHERE Id = ?', [id]);
    if (!p) throw notFound('المريض مش موجود');
    if (p.GlobalId && p.GlobalId !== gid) throw conflict('المريض ده مربوط بملف تاني');
    const other = await db.one('SELECT Id FROM Patients WHERE GlobalId = ? AND Id <> ?', [gid, id]);
    if (other) throw conflict('الرقم العالمي ده مربوط بمريض تاني');
    if (!p.GlobalId) {
      await db.tx(async (t) => { await t.run('UPDATE Patients SET GlobalId = ? WHERE Id = ?', [gid, id]); await audit(t, await sysUser(t), 'patient.link', 'Patient', id, { now: { globalId: gid }, note: `ربط من ${req.peer.name}` }); });
    }
    res.json({ ok: true });
  });
  r.post('/update', async (req, res) => {
    const gid = String(req.body.globalId || ''), i = req.body.identity || {};
    const p = await db.one('SELECT * FROM Patients WHERE GlobalId = ?', [gid]);
    if (!p) throw notFound('المريض مش مربوط عندنا');
    const mine = toIso(p.UpdatedAt || p.CreatedAt) || '';
    if (i.updatedAt && mine && i.updatedAt <= mine) return res.json({ ok: true, applied: false, reason: 'عندنا تعديل أحدث' });
    const d = toData(i);
    if (!d.FullName) throw bad('الاسم ناقص');
    if (d.NationalId && (await db.one('SELECT Id FROM Patients WHERE NationalId = ? AND Id <> ?', [d.NationalId, p.Id]))) throw conflict('الرقم القومي ده عند مريض تاني عندنا');
    const changes = [];
    for (const k of Object.keys(FIELD_LABEL)) {
      const a = k === 'BirthDate' ? toDateStr(p[k]) : p[k];
      if (String(a ?? '') !== String(d[k] ?? '')) changes.push([k, a, d[k]]);
    }
    if (!changes.length) return res.json({ ok: true, applied: false, reason: 'مفيش فرق' });
    const sys = await sysUser(db);
    await db.tx(async (t) => {
      const now = new Date();
      const sets = changes.map(([k]) => `${k} = ?`), vals = changes.map(([, , b]) => b);
      if (changes.some(([k]) => k === 'FullName')) { sets.push('SearchKey = ?'); vals.push(d.SearchKey); }
      if (changes.some(([k]) => k === 'AgeYears')) { sets.push('AgeRecordedAt = ?'); vals.push(d.AgeYears != null ? now : null); }
      sets.push('UpdatedAt = ?', 'UpdatedBy = ?');
      await t.run(`UPDATE Patients SET ${sets.join(', ')} WHERE Id = ?`, [...vals, now, sys?.id ?? p.CreatedBy, p.Id]);
      for (const [k, a, b] of changes) await t.insert('PatientEdits', { PatientId: p.Id, At: now, UserId: sys?.id ?? p.CreatedBy, Field: k, OldValue: a == null ? null : String(a).slice(0, 500), NewValue: b == null ? null : String(b).slice(0, 500) });
      await audit(t, sys, 'patient.peerUpdate', 'Patient', p.Id, { note: `تعديل متزامن من ${req.peer.name}: ${changes.map(([k]) => FIELD_LABEL[k]).join('، ')}` });
    });
    res.json({ ok: true, applied: true });
  });

  // ---- طلبات الخدمات (الصفا كاث هي اللي بتستقبلها) ----
  r.get('/services', async (req, res) => {
    const rows = await db.query(`SELECT s.*, ${currentPriceSql()} AS Price FROM Services s WHERE s.Active = 1 ORDER BY s.Dept, s.SortOrder, s.Name`, [new Date()]);
    const docs = await db.query('SELECT Id, Name, Specialty FROM Doctors WHERE Active = 1 ORDER BY Name');
    res.json({
      services: rows.filter((x) => x.Price != null && VISIT_TYPES[x.Dept]).map((x) => ({ id: x.Id, code: x.Code, name: x.Name, dept: x.Dept, price: pounds(cents(x.Price)), hasDoctor: toBool(x.HasDoctor) })),
      doctors: docs.map((d) => ({ id: d.Id, name: d.Name, specialty: d.Specialty })),
    });
  });
  r.post('/requests', async (req, res) => {
    const p = await db.one('SELECT * FROM Patients WHERE GlobalId = ?', [String(req.body.globalId || '')]);
    if (!p) throw notFound('المريض مش مربوط عندنا. اربط الملف الأول');
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length || items.length > 10) throw bad('اختار من خدمة لـ 10 خدمات');
    const by = str(req.body.by, 100), note = str(req.body.note, 300);
    const sys = await sysUser(db);
    if (!sys) throw new HttpError(500, 'مفيش مدير في النسخة دي');
    const out = await db.tx(async (t) => {
      const made = [], visits = {};
      for (const it of items) {
        const svc = await getService(t, intId(it.serviceId, 'الخدمة'));
        if (!svc || !svc.active || svc.price == null || !VISIT_TYPES[svc.dept]) throw bad('خدمة مش متاحة');
        let doctorId = it.doctorId ? intId(it.doctorId, 'الدكتور') : null;
        if (svc.hasDoctor && !doctorId) throw bad(`اختار الدكتور لـ «${svc.name}»`);
        if (doctorId && !(await t.one('SELECT Id FROM Doctors WHERE Id = ? AND Active = 1', [doctorId]))) throw bad('الدكتور مش موجود');
        let vid = visits[svc.dept];
        if (!vid) {
          const { start } = cairoDayRange();
          const ex = await t.one(db.top("SELECT Id FROM Visits WHERE PatientId = ? AND Type = ? AND Status = 'open' AND OpenedAt >= ? ORDER BY Id DESC", 1), [p.Id, svc.dept, start]);
          vid = ex?.Id || await t.insert('Visits', { VisitNo: await t.nextNumber('visit'), PatientId: p.Id, Type: svc.dept, Status: 'open', OpenedAt: new Date(), OpenedBy: sys.id, Notes: `طلب من ${req.peer.name}${by ? ' · ' + by : ''}` });
          visits[svc.dept] = vid;
        }
        const share = await resolveDoctorShare(t, doctorId, svc.id, svc.dept);
        const unit = await servicePrice(t, null, svc.id, cents(svc.price));
        const c = await cover(t, null, { serviceId: svc.id, dept: svc.dept, amount: unit, patientId: p.Id, visitId: vid });
        const iid = await t.insert('VisitItems', {
          VisitId: vid, ServiceId: svc.id, ServiceName: svc.name, Dept: svc.dept, DoctorId: doctorId, Qty: 1,
          UnitPrice: pounds(unit), Amount: pounds(unit), PayTiming: svc.payTiming, DoctorPct: share.pct, DoctorFixed: pounds(share.fixed),
          PayerPct: c.pct, PayerAmount: pounds(c.payerAmount), PatientAmount: pounds(c.patientAmount), CoverStatus: c.status, RefundDue: 0,
          Status: 'active', AddedAt: new Date(), AddedBy: sys.id,
        });
        const rid = await t.insert('PeerRequests', { GlobalId: p.GlobalId, PatientId: p.Id, VisitId: vid, VisitItemId: iid, FromName: req.peer.name, FromUser: by, Note: note, Status: 'new', CreatedAt: new Date() });
        await audit(t, sys, 'peer.request', 'PeerRequest', rid, { now: { service: svc.name, from: req.peer.name, by } });
        made.push({ id: rid, service: svc.name, amount: pounds(unit) });
      }
      return made;
    });
    res.status(201).json({ requests: out, total: out.reduce((a, x) => a + x.amount, 0) });
  });
  const requestRows = (where, params) => db.query(db.top(`SELECT q.*, i.ServiceName, i.Amount, i.PatientAmount, i.PaidReceiptId, i.PendingOrderId, i.Status AS ItemStatus, i.DoctorId FROM PeerRequests q JOIN VisitItems i ON i.Id = q.VisitItemId WHERE ${where} ORDER BY q.Id DESC`, 40), params);
  const reqDto = (x) => ({
    id: x.Id, service: x.ServiceName, amount: pounds(cents(x.PatientAmount ?? x.Amount)), paid: x.PaidReceiptId != null, fromUser: x.FromUser, note: x.Note,
    status: x.Status === 'cancelled' || x.ItemStatus === 'voided' ? 'cancelled' : x.Status, createdAt: toIso(x.CreatedAt), doneAt: toIso(x.DoneAt),
  });
  r.get('/requests', async (req, res) => {
    const rows = await requestRows('q.GlobalId = ?', [String(req.query.globalId || '')]);
    res.json({ requests: rows.map(reqDto) });
  });
  r.post('/requests/:id/cancel', async (req, res) => {
    const q = await db.one('SELECT q.*, i.PaidReceiptId, i.PendingOrderId, i.ServiceName FROM PeerRequests q JOIN VisitItems i ON i.Id = q.VisitItemId WHERE q.Id = ?', [intId(req.params.id)]);
    if (!q) throw notFound('الطلب مش موجود');
    if (q.Status !== 'new') throw conflict(q.Status === 'done' ? 'الطلب ده اتنفّذ' : 'الطلب ده اتلغى قبل كده');
    if (q.PaidReceiptId != null) throw conflict('الطلب ده اتدفع. المرتجع من خزينة الصفا كاث');
    if (q.PendingOrderId != null) throw conflict('الطلب ده في إذن دفع مستني الخزينة عندنا. اتواصل معاهم');
    const sys = await sysUser(db);
    const why = `${str(req.body.by, 100) || req.peer.name}: ${str(req.body.reason, 100) || 'إلغاء قبل الدفع'}`;
    await db.tx(async (t) => {
      await t.run("UPDATE VisitItems SET Status = 'voided', VoidedAt = ?, VoidedBy = ?, VoidReason = ? WHERE Id = ?", [new Date(), sys.id, why.slice(0, 300), q.VisitItemId]);
      await t.run("UPDATE PeerRequests SET Status = 'cancelled', CancelReason = ? WHERE Id = ?", [why.slice(0, 200), q.Id]);
      await audit(t, sys, 'peer.request.cancel', 'PeerRequest', q.Id, { old: { service: q.ServiceName }, note: why });
    });
    res.json({ ok: true });
  });
  r.post('/events', async (req, res) => {
    const p = await db.one('SELECT Id FROM Patients WHERE GlobalId = ?', [String(req.body.globalId || '')]);
    if (!p) throw notFound('المريض مش مربوط عندنا');
    if (!['to_peer', 'from_peer'].includes(req.body.kind)) throw bad('نوع الحدث مش صحيح');
    await db.insert('PeerEvents', { GlobalId: String(req.body.globalId), PatientId: p.Id, Kind: req.body.kind, Origin: 'remote', At: req.body.at ? new Date(req.body.at) : new Date(), ByName: str(req.body.by, 100), Note: str(req.body.note, 200) });
    res.json({ ok: true });
  });

  // ---- كاشير موحّد: المنشأة دي بتشتغل باسم كاشير المنشأة التانية (لازم نفس اسم المستخدم هنا ومعاه صلاحية التحصيل) ----
  const cashierOf = async (name) => {
    const u = await userByUsername(db, name);
    if (!u) throw conflict(`مفيش مستخدم باسم «${name}» هنا. اعمل له حساب بنفس اسم المستخدم`);
    if (!can(u, 'cash.collect')) throw conflict(`«${u.name}» معهوش صلاحية التحصيل هنا`);
    if (await mustOrder(db, u)) throw conflict('الكاشير ده مش مسموح له يحصّل مباشرة هنا');
    return u;
  };
  const shiftOf = async (u) => {
    const s = await db.one(db.top('SELECT Id, OpenedAt, Label FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [u.id]);
    return s ? { open: true, id: s.Id, openedAt: toIso(s.OpenedAt), label: s.Label } : { open: false };
  };
  r.get('/cashier/state', async (req, res) => {
    const u = await cashierOf(String(req.query.as || ''));
    const p = req.query.globalId ? await db.one('SELECT Id FROM Patients WHERE GlobalId = ?', [String(req.query.globalId)]) : null;
    const d = p ? await dueItems(db, p.Id) : { items: [], total: 0 };
    res.json({ cashier: u.name, shift: await shiftOf(u), items: d.items.map((i) => ({ id: i.id, name: i.name, amount: pounds(i.cents) })), total: pounds(d.total) });
  });
  r.post('/cashier/shift/open', async (req, res) => {
    const u = await cashierOf(String(req.body.as || ''));
    const open = await db.one(db.top('SELECT Id FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [u.id]);
    if (!open) {
      await db.tx(async (t) => {
        const now = new Date();
        const x = await t.insert('Shifts', { UserId: u.id, OpenedAt: now, Label: shiftLabel(now), BusinessDate: businessDate(now), Explicit: 1 });
        await audit(t, u, 'shift.open', 'Shift', x, { now: { via: req.peer.name } });
      });
    } else await db.run('UPDATE Shifts SET Explicit = 1 WHERE Id = ?', [open.Id]);
    res.status(201).json({ shift: await shiftOf(u) });
  });
  r.post('/cashier/collect', async (req, res) => {
    const u = await cashierOf(String(req.body.as || ''));
    const p = await db.one('SELECT Id FROM Patients WHERE GlobalId = ?', [String(req.body.globalId || '')]);
    if (!p) throw notFound('المريض مش مربوط عندنا');
    const cash = parseMoney(req.body.cash, 'النقدي'), card = parseMoney(req.body.card, 'الفيزا');
    const d = await dueItems(db, p.Id);
    if (!d.items.length) throw conflict('مفيش مستحقات هنا على المريض ده');
    if (cash + card !== d.total) throw bad(`المستحق هنا اتغيّر (${pounds(d.total)}). حدّث الشاشة`, { due: pounds(d.total) });
    if (req.body.check) return res.json({ ok: true, total: pounds(d.total) });
    const receipts = await db.tx(async (t) => {
      const out = await collectAll(t, u, p.Id, { cash, card, manualNo: req.body.manualNo });
      await audit(t, u, 'peer.collect', 'Patient', p.Id, { now: { via: req.peer.name, receipts: out } });
      return out;
    });
    res.status(201).json({ receipts, total: pounds(d.total) });
  });
  r.post('/unlink', async (req, res) => {
    const p = await db.one('SELECT Id FROM Patients WHERE GlobalId = ?', [String(req.body.globalId || '')]);
    if (p) await db.tx(async (t) => { await t.run('UPDATE Patients SET GlobalId = NULL WHERE Id = ?', [p.Id]); await audit(t, await sysUser(t), 'patient.unlink', 'Patient', p.Id, { note: `فك ربط من ${req.peer.name}` }); });
    res.json({ ok: true });
  });
  return r;
}

/** ===== واجهة الموظفين ===== */
export default function peerRouter(db) {
  const r = router();
  const mark = async (list) => { // بيعلّم اللي له ملف عندنا
    const out = [];
    for (const x of list) {
      const byG = x.globalId ? await db.one('SELECT Id, PatientNo FROM Patients WHERE GlobalId = ?', [x.globalId]) : null;
      const byN = !byG && x.nationalId ? await db.one('SELECT Id, PatientNo, GlobalId FROM Patients WHERE NationalId = ?', [x.nationalId]) : null;
      out.push({ ...x, local: byG ? { id: byG.Id, no: byG.PatientNo, linked: true } : byN ? { id: byN.Id, no: byN.PatientNo, linked: !!byN.GlobalId, sameNid: true } : null });
    }
    return out;
  };

  r.get('/status', async (req, res) => {
    need(req.user, 'patients.read');
    const c = await peerCfg(db);
    if (!c.enabled) return res.json({ enabled: false });
    const ping = req.query.ping ? await peerCall(db, 'GET', '/ping', null, c) : null;
    const pending = Number((await db.one('SELECT COUNT(*) AS N FROM PeerOutbox WHERE DoneAt IS NULL'))?.N) || 0;
    res.json({ enabled: true, name: c.name, pending, reachable: ping ? ping.ok : undefined });
  });

  r.get('/search', async (req, res) => {
    need(req.user, 'patients.read');
    const c = await peerCfg(db);
    if (!c.enabled) throw bad('الربط مش متفعّل');
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [], peerName: c.name });
    const r1 = await peerCall(db, 'GET', '/patients?q=' + encodeURIComponent(q), null, c);
    if (!r1.ok) throw new HttpError(502, `${c.name}: ${r1.error}`);
    res.json({ results: await mark(r1.body.patients || []), peerName: c.name });
  });

  r.get('/suggest/:id', async (req, res) => {
    need(req.user, 'patients.read');
    const c = await peerCfg(db);
    const p = await db.one('SELECT * FROM Patients WHERE Id = ?', [intId(req.params.id)]);
    if (!p) throw notFound('المريض مش موجود');
    if (!c.enabled) return res.json({ enabled: false });
    const link = { linked: !!p.GlobalId, peerName: c.name, enabled: true };
    if (p.GlobalId) { const ev = await db.one(db.top('SELECT * FROM PeerEvents WHERE PatientId = ? ORDER BY Id DESC', 1), [p.Id]); link.lastEvent = ev ? { kind: ev.Kind, origin: ev.Origin, at: toIso(ev.At), by: ev.ByName } : null; }
    if (p.GlobalId) {
      const r1 = await peerCall(db, 'GET', '/patients?globalId=' + encodeURIComponent(p.GlobalId), null, c);
      return res.json({ ...link, remote: r1.ok ? (r1.body.patients || [])[0] || null : null, reachable: r1.ok });
    }
    if (!p.NationalId) return res.json({ ...link, candidate: null });
    const r1 = await peerCall(db, 'GET', '/patients?nid=' + p.NationalId, null, c);
    const cand = r1.ok ? (r1.body.patients || []).find((x) => !x.globalId) || null : null;
    res.json({ ...link, candidate: cand, reachable: r1.ok });
  });

  r.post('/import', async (req, res) => {
    need(req.user, 'patients.write');
    const c = await peerCfg(db);
    if (!c.enabled) throw bad('الربط مش متفعّل');
    const r1 = await peerCall(db, 'GET', '/patients?id=' + intId(req.body.remoteId), null, c);
    if (!r1.ok) throw new HttpError(502, `${c.name}: ${r1.error}`);
    const rem = (r1.body.patients || [])[0];
    if (!rem) throw notFound('المريض مش موجود عند ' + c.name);
    const d = toData(rem);
    if (!d.FullName) throw bad('اسم المريض ناقص عند ' + c.name);
    if (rem.globalId && await db.one('SELECT Id FROM Patients WHERE GlobalId = ?', [rem.globalId])) throw conflict('المريض ده مستورد قبل كده');
    if (d.NationalId) {
      const ex = await db.one('SELECT Id, PatientNo, FullName FROM Patients WHERE NationalId = ?', [d.NationalId]);
      if (ex) throw conflict(`الرقم القومي ده متسجل عندنا لملف رقم ${ex.PatientNo} (${ex.FullName}). اربطه بدل ما تستورده`, { localId: ex.Id });
    }
    const gid = rem.globalId || newGlobalId();
    if (!rem.globalId) {
      const l = await peerCall(db, 'POST', '/link', { id: rem.id, globalId: gid }, c);
      if (!l.ok) throw new HttpError(502, `${c.name}: ${l.error}`);
    }
    const id = await db.tx(async (t) => {
      const pid = await createPatient(t, req.user, { ...d, GlobalId: gid }, { quick: false });
      await audit(t, req.user, 'patient.import', 'Patient', pid, { now: { from: c.name, remoteNo: rem.no, globalId: gid } });
      return pid;
    });
    res.status(201).json({ patient: patientDto(await db.one('SELECT * FROM Patients WHERE Id = ?', [id])) });
  });

  r.post('/link', async (req, res) => {
    need(req.user, 'patients.write');
    const c = await peerCfg(db);
    if (!c.enabled) throw bad('الربط مش متفعّل');
    const id = intId(req.body.localId);
    const p = await db.one('SELECT * FROM Patients WHERE Id = ?', [id]);
    if (!p) throw notFound('المريض مش موجود');
    const r1 = await peerCall(db, 'GET', '/patients?id=' + intId(req.body.remoteId), null, c);
    if (!r1.ok) throw new HttpError(502, `${c.name}: ${r1.error}`);
    const rem = (r1.body.patients || [])[0];
    if (!rem) throw notFound('المريض مش موجود عند ' + c.name);
    if (p.GlobalId && rem.globalId && p.GlobalId !== rem.globalId) throw conflict('الاتنين مربوطين بملفات تانية');
    if (p.GlobalId && p.GlobalId === rem.globalId) return res.json({ ok: true, already: true });
    if (p.GlobalId && !rem.globalId === false) throw conflict('الملف مربوط بالفعل');
    const gid = rem.globalId || p.GlobalId || newGlobalId();
    if (!rem.globalId) {
      const l = await peerCall(db, 'POST', '/link', { id: rem.id, globalId: gid }, c);
      if (!l.ok) throw new HttpError(502, `${c.name}: ${l.error}`);
    }
    await db.tx(async (t) => {
      await t.run('UPDATE Patients SET GlobalId = ? WHERE Id = ?', [gid, id]);
      await audit(t, req.user, 'patient.link', 'Patient', id, { now: { with: c.name, remoteNo: rem.no, globalId: gid } });
    });
    res.json({ ok: true });
  });

  r.post('/unlink', async (req, res) => {
    need(req.user, 'peer.manage');
    const id = intId(req.body.localId);
    const p = await db.one('SELECT * FROM Patients WHERE Id = ?', [id]);
    if (!p?.GlobalId) throw bad('الملف مش مربوط');
    await db.tx(async (t) => {
      await t.run('UPDATE Patients SET GlobalId = NULL WHERE Id = ?', [id]);
      await audit(t, req.user, 'patient.unlink', 'Patient', id, { old: { globalId: p.GlobalId } });
    });
    await enqueueUnlink(db, p.GlobalId);
    flushOutbox(db).catch(() => {});
    res.json({ ok: true });
  });


  // ---- طلب خدمات من المنشأة التانية (بيتمنع لو الاتصال واقع) ----
  const remote = async (c, method, path, body) => {
    const x = await peerCall(db, method, path, body, c);
    if (x.status === 0) throw new HttpError(503, `مفيش اتصال بـ ${c.name} دلوقتي، مينفعش تطلب خدمة. جرّب تاني بعد شوية`);
    if (!x.ok) throw new HttpError(x.status, `${c.name}: ${x.error}`);
    return x.body;
  };
  r.get('/services', async (req, res) => {
    need(req.user, 'visits.write');
    const c = await peerCfg(db);
    if (!c.enabled) throw bad('الربط مش متفعّل');
    res.json({ ...(await remote(c, 'GET', '/services')), peerName: c.name });
  });
  r.post('/requests', async (req, res) => {
    need(req.user, 'visits.write');
    const c = await peerCfg(db);
    if (!c.enabled) throw bad('الربط مش متفعّل');
    const p = await db.one('SELECT * FROM Patients WHERE Id = ?', [intId(req.body.patientId, 'المريض')]);
    if (!p) throw notFound('المريض مش موجود');
    if (!p.GlobalId) throw conflict(`المريض لازم يتربط بملف في ${c.name} الأول`);
    const out = await remote(c, 'POST', '/requests', { globalId: p.GlobalId, items: req.body.items, note: req.body.note, by: req.user.name });
    await audit(db, req.user, 'peer.request', 'Patient', p.Id, { now: { to: c.name, requests: out.requests, total: out.total } });
    res.status(201).json({ ...out, peerName: c.name });
  });
  r.get('/requests/:patientId', async (req, res) => {
    need(req.user, 'visits.read');
    const c = await peerCfg(db);
    const p = await db.one('SELECT GlobalId FROM Patients WHERE Id = ?', [intId(req.params.patientId)]);
    if (!c.enabled || !p?.GlobalId) return res.json({ requests: [] });
    const x = await peerCall(db, 'GET', '/requests?globalId=' + encodeURIComponent(p.GlobalId), null, c);
    res.json({ requests: x.ok ? x.body.requests : [], reachable: x.ok });
  });
  r.post('/requests/:id/cancel', async (req, res) => {
    need(req.user, 'visits.write');
    const c = await peerCfg(db);
    await remote(c, 'POST', `/requests/${intId(req.params.id)}/cancel`, { by: req.user.name, reason: req.body?.reason });
    await audit(db, req.user, 'peer.request.cancel', 'PeerRequest', intId(req.params.id), { note: `إلغاء طلب عند ${c.name}` });
    res.json({ ok: true });
  });

  // ---- كاشير موحّد على الشاشة: الاتنين منشأتين، مبلغين وإيصالين ----
  const cashierUser = async (req) => {
    need(req.user, 'cash.collect');
    if (await mustOrder(db, req.user)) throw conflict('التحصيل المباشر مش متاح لحسابك دلوقتي');
  };
  r.get('/cashier/:patientId', async (req, res) => {
    await cashierUser(req);
    const c = await peerCfg(db);
    const pid = intId(req.params.patientId);
    const p = await db.one('SELECT Id, FullName, GlobalId FROM Patients WHERE Id = ?', [pid]);
    if (!p) throw notFound('المريض مش موجود');
    const mine = await dueItems(db, pid);
    const sh = await db.one(db.top('SELECT Id FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [req.user.id]);
    const out = { patient: { id: p.Id, name: p.FullName, linked: !!p.GlobalId }, peerName: c.name, enabled: c.enabled,
      local: { items: mine.items.map((i) => ({ id: i.id, name: i.name, amount: pounds(i.cents) })), total: pounds(mine.total), shift: { open: !!sh } }, peer: null };
    if (c.enabled && p.GlobalId) {
      const x = await peerCall(db, 'GET', `/cashier/state?globalId=${encodeURIComponent(p.GlobalId)}&as=${encodeURIComponent(req.user.username)}`, null, c);
      out.peer = x.ok ? { reachable: true, ...x.body } : { reachable: x.status !== 0, error: x.error };
    }
    res.json(out);
  });
  r.post('/cashier/shift/open', async (req, res) => {
    await cashierUser(req);
    const c = await peerCfg(db);
    const mine = await db.one(db.top('SELECT Id FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [req.user.id]);
    if (!mine) {
      await db.tx(async (t) => {
        const now = new Date();
        const x = await t.insert('Shifts', { UserId: req.user.id, OpenedAt: now, Label: shiftLabel(now), BusinessDate: businessDate(now), Explicit: 1 });
        await audit(t, req.user, 'shift.open', 'Shift', x, { now: { via: 'التحصيل المدمج' } });
      });
    } else await db.run('UPDATE Shifts SET Explicit = 1 WHERE Id = ?', [mine.Id]);
    if (c.enabled) await remote(c, 'POST', '/cashier/shift/open', { as: req.user.username });
    res.status(201).json({ ok: true });
  });
  r.post('/cashier/collect', async (req, res) => {
    await cashierUser(req);
    const c = await peerCfg(db);
    const b = req.body || {};
    const p = await db.one('SELECT Id, GlobalId FROM Patients WHERE Id = ?', [intId(b.patientId, 'المريض')]);
    if (!p) throw notFound('المريض مش موجود');
    const lc = parseMoney(b.local?.cash, 'النقدي (المستشفى)'), ld = parseMoney(b.local?.card, 'الفيزا (المستشفى)');
    const pc = parseMoney(b.peer?.cash, `النقدي (${c.name})`), pd = parseMoney(b.peer?.card, `الفيزا (${c.name})`);
    const mine = await dueItems(db, p.Id);
    const needPeer = c.enabled && p.GlobalId && (pc + pd) > 0;
    if (!mine.items.length && !needPeer) throw conflict('مفيش حاجة تتحصّل');
    if (mine.items.length && lc + ld !== mine.total) throw bad(`المستحق في المستشفى اتغيّر (${pounds(mine.total)}). حدّث الشاشة`);
    if (!mine.items.length && lc + ld > 0) throw bad('مفيش مستحقات في المستشفى');
    // 1) فحص مسبق عند المنشأة التانية: لو واقعة أو المبلغ اتغيّر الدفع المدمج كله بيتمنع
    if (needPeer) await remote(c, 'POST', '/cashier/collect', { as: req.user.username, globalId: p.GlobalId, cash: b.peer.cash, card: b.peer.card, check: true });
    // 2) تحصيل المستشفى
    let local = [];
    if (mine.items.length) {
      local = await db.tx(async (t) => {
        const out = await collectAll(t, req.user, p.Id, { cash: lc, card: ld, manualNo: b.local?.manualNo });
        await audit(t, req.user, 'peer.collect', 'Patient', p.Id, { now: { combined: true, receipts: out } });
        return out;
      });
    }
    // 3) تحصيل المنشأة التانية (بعد الفحص المسبق). لو فشل هنا المستشفى يفضل متحصّل والمنشأة التانية تتحصّل لوحدها
    let other = [];
    if (needPeer) {
      try { other = (await remote(c, 'POST', '/cashier/collect', { as: req.user.username, globalId: p.GlobalId, cash: b.peer.cash, card: b.peer.card, manualNo: b.peer?.manualNo })).receipts; }
      catch (e) { return res.status(207).json({ partial: true, local, peer: [], error: e.message, peerName: c.name }); }
    }
    res.status(201).json({ local, peer: other, peerName: c.name });
  });

  // ---- أحداث الانتقال (بتتخزن عندنا وبتتبعت للتانية، وبتستنى في الطابور لو الاتصال واقع) ----
  r.post('/events', async (req, res) => {
    need(req.user, 'visits.write');
    const kind = req.body.kind;
    if (!['to_peer', 'from_peer'].includes(kind)) throw bad('نوع الحدث مش صحيح');
    const p = await db.one('SELECT Id, GlobalId FROM Patients WHERE Id = ?', [intId(req.body.patientId, 'المريض')]);
    if (!p?.GlobalId) throw conflict('المريض مش مربوط');
    const at = new Date(), note = str(req.body.note, 200);
    await db.tx(async (t) => { await t.insert('PeerEvents', { GlobalId: p.GlobalId, PatientId: p.Id, Kind: kind, Origin: 'local', At: at, ByName: req.user.name, Note: note }); });
    await enqueueEvent(db, p.GlobalId, { kind, at: at.toISOString(), by: req.user.name, note });
    flushOutbox(db).catch(() => {});
    res.status(201).json({ ok: true });
  });
  r.get('/events/:patientId', async (req, res) => {
    need(req.user, 'visits.read');
    const rows = await db.query(db.top('SELECT * FROM PeerEvents WHERE PatientId = ? ORDER BY Id DESC', 8), [intId(req.params.patientId)]);
    res.json({ events: rows.map((e) => ({ id: e.Id, kind: e.Kind, origin: e.Origin, at: toIso(e.At), by: e.ByName, note: e.Note })) });
  });

  // ---- قايمة شغل الطلبات الجاية من المنشأة التانية (على نسخة الصفا كاث) ----
  r.get('/work', async (req, res) => {
    need(req.user, 'peer.work');
    const c = await peerCfg(db);
    const since = new Date(Date.now() - 24 * 3600e3);
    const rows = await db.query(`SELECT q.*, i.ServiceName, i.PatientAmount, i.PaidReceiptId, i.Status AS ItemStatus, p.FullName, p.PatientNo, p.AgeYears, p.BirthDate, p.Sex, d.Name AS DoctorName
        FROM PeerRequests q JOIN VisitItems i ON i.Id = q.VisitItemId JOIN Patients p ON p.Id = q.PatientId LEFT JOIN Doctors d ON d.Id = i.DoctorId
       WHERE q.Status = 'new' OR (q.Status = 'done' AND q.DoneAt >= ?) ORDER BY q.Status, q.Id`, [since]);
    const list = [];
    for (const x of rows) {
      if (x.ItemStatus === 'voided') continue;
      const ev = await db.one(db.top('SELECT * FROM PeerEvents WHERE PatientId = ? ORDER BY Id DESC', 1), [x.PatientId]);
      list.push({ id: x.Id, patient: { id: x.PatientId, no: x.PatientNo, name: x.FullName, sex: x.Sex }, service: x.ServiceName, doctor: x.DoctorName, amount: pounds(cents(x.PatientAmount)), paid: x.PaidReceiptId != null,
        status: x.Status, fromName: x.FromName, fromUser: x.FromUser, note: x.Note, createdAt: toIso(x.CreatedAt), doneAt: toIso(x.DoneAt), event: ev ? { kind: ev.Kind, origin: ev.Origin, at: toIso(ev.At), by: ev.ByName } : null });
    }
    res.json({ requests: list, peerName: c.name, requirePaid: c.requirePaid });
  });
  r.post('/work/:id/done', async (req, res) => {
    need(req.user, 'peer.work');
    const c = await peerCfg(db);
    const q = await db.one('SELECT q.*, i.PaidReceiptId, i.Status AS ItemStatus FROM PeerRequests q JOIN VisitItems i ON i.Id = q.VisitItemId WHERE q.Id = ?', [intId(req.params.id)]);
    if (!q || q.Status === 'cancelled' || q.ItemStatus === 'voided') throw notFound('الطلب مش موجود أو اتلغى');
    if (q.Status === 'done') throw conflict('الطلب ده اتنفّذ قبل كده');
    if (c.requirePaid && q.PaidReceiptId == null) throw conflict('الخدمة لسه ما اتدفعتش. المدير يقدر يسمح بالتنفيذ قبل الدفع من إعدادات الربط');
    await db.tx(async (t) => {
      await t.run("UPDATE PeerRequests SET Status = 'done', DoneAt = ?, DoneBy = ? WHERE Id = ?", [new Date(), req.user.id, q.Id]);
      await audit(t, req.user, 'peer.request.done', 'PeerRequest', q.Id, { note: 'تنفيذ' });
    });
    res.json({ ok: true });
  });
  r.post('/work/:id/reopen', async (req, res) => {
    need(req.user, 'peer.manage');
    const q = await db.one('SELECT * FROM PeerRequests WHERE Id = ?', [intId(req.params.id)]);
    if (!q || q.Status !== 'done') throw conflict('الطلب مش منفّذ');
    await db.tx(async (t) => {
      await t.run("UPDATE PeerRequests SET Status = 'new', DoneAt = NULL, DoneBy = NULL WHERE Id = ?", [q.Id]);
      await audit(t, req.user, 'peer.request.reopen', 'PeerRequest', q.Id, { note: str(req.body?.reason, 200) || 'إعادة فتح' });
    });
    res.json({ ok: true });
  });


  // ---- انتقال بنفس الحساب للمنشأة التانية ----
  r.get('/switch-info', async (req, res) => {
    const c = await peerCfg(db);
    res.json({ enabled: c.enabled && can(req.user, 'peer.switch'), name: c.name });
  });
  r.get('/switch-url', async (req, res) => {
    need(req.user, 'peer.switch');
    const c = await peerCfg(db);
    const base = c.publicUrl || c.url;
    if (!c.enabled || !base || !c.key) throw bad('الربط مش متظبط');
    const q = signSwitch(c.key, req.user.username);
    await audit(db, req.user, 'peer.switch', 'User', req.user.id, { note: `انتقال إلى ${c.name}` });
    res.json({ url: `${base}/peer-sso?${new URLSearchParams({ u: q.u, t: String(q.t), n: q.n, s: q.s })}` });
  });

  // ---- إعدادات الربط (المدير) ----
  r.get('/config', async (req, res) => {
    need(req.user, 'peer.manage');
    const c = await peerCfg(db);
    const rows = await db.query(db.top('SELECT Id, GlobalId, Op, CreatedAt, Attempts, LastError, DoneAt FROM PeerOutbox ORDER BY Id DESC', 15));
    const pending = Number((await db.one('SELECT COUNT(*) AS N FROM PeerOutbox WHERE DoneAt IS NULL'))?.N) || 0;
    const linked = Number((await db.one('SELECT COUNT(*) AS N FROM Patients WHERE GlobalId IS NOT NULL'))?.N) || 0;
    res.json({ enabled: c.enabled, name: c.name, url: c.url, hasKey: c.hasKey, requirePaid: c.requirePaid, publicUrl: c.publicUrl, pending, linked, outbox: rows.map((o) => ({ id: o.Id, op: o.Op, at: toIso(o.CreatedAt), attempts: o.Attempts, error: o.LastError, done: !!o.DoneAt })) });
  });
  r.put('/config', async (req, res) => {
    need(req.user, 'peer.manage');
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 'on' : 'off';
    if (b.name !== undefined) patch.name = str(b.name, 60) || 'المنشأة التانية';
    if (b.requirePaid !== undefined) patch.requirePaid = b.requirePaid ? 'on' : 'off';
    if (b.publicUrl !== undefined) {
      const u = String(b.publicUrl || '').trim();
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw bad('العنوان لازم يبدأ بـ http:// أو https://');
      patch.publicUrl = u;
    }
    if (b.url !== undefined) {
      const u = String(b.url || '').trim();
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw bad('العنوان لازم يبدأ بـ http:// أو https://');
      patch.url = u;
    }
    if (b.key !== undefined && String(b.key).length) {
      if (!/^[\x21-\x7E]{16,200}$/.test(String(b.key))) throw bad('مفتاح الربط لازم يكون 16 حرف على الأقل، إنجليزي وأرقام ورموز بس (من غير مسافات)');
      patch.key = String(b.key);
    }
    await setPeer(db, req.user, patch);
    await audit(db, req.user, 'peer.config', 'Settings', null, { now: { ...patch, key: patch.key ? '***' : undefined } });
    res.json({ ok: true });
  });
  r.post('/test', async (req, res) => {
    need(req.user, 'peer.manage');
    const c = await peerCfg(db);
    const p = await peerCall(db, 'GET', '/ping', null, { ...c, enabled: true });
    res.json({ ok: p.ok, name: p.body?.name || null, error: p.ok ? null : p.error });
  });
  r.post('/flush', async (req, res) => { need(req.user, 'peer.manage'); res.json(await flushOutbox(db)); });
  return r;
}

/** صفحة الدخول الموحّد (المتصفح بيجيلها من المنشأة التانية): بتتحقق من التوقيع وتفتح جلسة لنفس اسم المستخدم هنا */
export function peerSso(db, config) {
  return async (req, res) => {
    try {
      const c = await peerCfg(db);
      if (!c.enabled || !verifySwitch(c.key, req.query)) return res.status(403).type('html').send(ssoMsg('الرابط منتهي أو مش صحيح. ارجع للمنشأة التانية وجرّب تاني'));
      const u = await userByUsername(db, req.query.u);
      if (!u || !can(u, 'peer.switch')) return res.status(403).type('html').send(ssoMsg(`مفيش لك حساب مفعّل هنا بنفس اسم المستخدم، أو معندكش صلاحية الانتقال. كلّم المدير`));
      const token = await createSession(db, u.id, config.sessionHours);
      await db.run('UPDATE Users SET LastLoginAt = ? WHERE Id = ?', [new Date(), u.id]);
      await audit(db, u, 'login.peer', 'User', u.id, { note: `دخول موحّد من ${c.name}` });
      res.cookie(config.cookieName || 'elsafa_sid', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionHours * 3600e3, path: '/' });
      res.redirect('/');
    } catch (e) { res.status(500).type('html').send(ssoMsg('حصلت مشكلة: ' + e.message)); }
  };
}
const ssoMsg = (m) => `<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:sans-serif;padding:40px;text-align:center"><h3>${m}</h3></body>`;
