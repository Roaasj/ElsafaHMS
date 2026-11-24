// اختبارات الشريحة 8: حسابات الإقامة (التذكرة اليومية، قفلها وفتحها، الأصناف، المستحقات اللاحقة)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { cairoDate } from '../src/lib/util.js';

let ctx, base, rec, mgr, acc, sup, cas, svc, docs, stock;
async function login(u, p = 'Safa@2026') {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: raw ? { cookie } : { 'content-type': 'application/json', cookie }, body: raw || (body ? JSON.stringify(body) : undefined) });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b), raw: (u, buf) => call('POST', u, null, buf) };
}
let n = 0;
async function admit(extra = {}) {
  n++;
  const p = (await rec.post('/api/patients', {
    name: `مريض تذكرة رقم ${n} محمود`, phone: `0107777${String(n).padStart(4, '0')}`, ageYears: 50, sex: 'M', address: 'دمياط',
    nationalId: `276010111${String(n).padStart(3, '0')}1${n % 10}`, emergencyName: 'ابنه', emergencyPhone: '01012345678', confirmDuplicatePhone: true,
  })).body.patient;
  const b = (await rec.get('/api/admissions/beds/board')).body;
  let bed, cls;
  for (const f of b.floors) for (const r of f.rooms) for (const x of r.beds) if (!bed && x.status === 'free' && r.cls.kind === 'ward' && r.cls.nightPrice) { bed = x; cls = r.cls; }
  const a = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: cls.deposit, cash: cls.deposit, ...extra });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  return { aid: a.body.admission.id, p, cls };
}
const item = (name) => stock.find((s) => s.name === name);

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  acc = client(await login('acc'));
  sup = client(await login('accsuper'));
  cas = client(await login('cashier'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  stock = (await acc.get('/api/tickets/items')).body.items;
  await mgr.put('/api/admin/settings', { checkoutTime: '23:59' });
  await mgr.put('/api/admin/ticket-settings', { stockDeduct: 'off' }); // المخزن ليه اختباراته
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

test('نظام التذكرة: الاستقبال مايضيفش بنود، والخروج محتاج قفل التذكرة', async () => {
  const { aid } = await admit();
  assert.equal((await rec.post(`/api/admissions/${aid}/items`, { serviceId: svc['IP-002'].id })).status, 403);
  const d = await rec.post(`/api/admissions/${aid}/discharge`, {});
  assert.equal(d.status, 409);
  assert.match(d.body.error, /التذكرة/);
  // الحسابات مش بتشوف شاشة الخزينة ولا بتقبض
  assert.equal((await acc.post(`/api/admissions/${aid}/pay`, { cash: 100 })).status, 403);
});

test('دفعة تذكرة: خدمات وأدوية ومستلزمات وأتعاب وزيارات، بالأسعار، وكذا دفعة في اليوم', async () => {
  const { aid } = await admit();
  // الأتعاب لازم دكتور
  const noDoc = await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'fee', serviceId: svc['OR-006'].id, price: 2500 }] });
  assert.equal(noDoc.status, 400);
  assert.match(noDoc.body.error, /الدكتور/);
  // الصنف من نوع غلط
  assert.equal((await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'supply', stockItemId: item('سيفترياكسون 1 جم').id }] })).status, 400);
  const r1 = await acc.post(`/api/tickets/adm/${aid}`, {
    paperNo: '1452',
    lines: [
      { cat: 'drug', stockItemId: item('سيفترياكسون 1 جم').id, qty: 2 }, // 170
      { cat: 'drug', stockItemId: item('محلول ملح 0.9% 500 مل').id, qty: 3 }, // 66
      { cat: 'supply', stockItemId: item('كانيولا 20G').id }, // 18
      { cat: 'service', serviceId: svc['IP-002'].id, qty: 4 }, // 200
      { cat: 'visit', serviceId: svc['IP-007'].id, doctorId: docs[1].id }, // 500
      { cat: 'fee', serviceId: svc['OR-006'].id, doctorId: docs[2].id, price: 2500 }, // سعر مفتوح
    ],
  });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.ticket.total, 170 + 66 + 18 + 200 + 500 + 2500);
  const bc = r1.body.totals.byCat;
  assert.equal(bc.drug, 236);
  assert.equal(bc.supply, 18);
  assert.equal(bc.service, 200);
  assert.equal(bc.visit, 500);
  assert.equal(bc.fee, 2500);
  assert.ok(bc.night > 0);
  assert.equal(r1.body.tickets.length, 1);
  assert.equal(r1.body.tickets[0].paperNo, '1452');
  assert.equal(r1.body.tickets[0].date, cairoDate());
  // دفعة تانية في نفس اليوم (شيفت تاني)
  const r2 = await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'drug', stockItemId: item('كيتورولاك 30 مجم').id, qty: 2 }] });
  assert.equal(r2.body.tickets.length, 2);
  assert.equal(r2.body.days.at(-1).tickets, 2);
  // شيل بند بسبب
  const line = r2.body.items.find((i) => i.name.startsWith('كيتورولاك'));
  assert.equal((await sup.del(`/api/tickets/adm/${aid}/items/${line.id}`, {})).status, 400); // سطر موظف تاني: لازم سبب
  const rm = await acc.del(`/api/tickets/adm/${aid}/items/${line.id}`, { reason: 'اتكتب غلط' });
  assert.equal(rm.status, 200);
  assert.equal(rm.body.tickets[1].lines, 0);
  assert.equal(rm.body.tickets[1].voided, 1);
  // تاريخ قبل الدخول مرفوض
  assert.equal((await acc.post(`/api/tickets/adm/${aid}`, { date: '2020-01-01', lines: [{ cat: 'supply', stockItemId: item('شاش معقم').id }] })).status, 400);
});

test('لوحة الحسابات: مين اتكتبله النهارده، والأيام الناقصة', async (t) => {
  // يوم الحسابات بيبدأ 8 الصبح: من نص الليل لـ 8 «النهارده» لسه امبارح، فالعدّ بيختلف
  if (Number(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false })) < 8) return t.skip('بيتجرب بعد 8 الصبح');
  const { aid } = await admit();
  // نرجّع الدخول 3 أيام لورا
  await ctx.db.run('UPDATE Admissions SET AdmittedAt = ? WHERE Id = ?', [new Date(Date.now() - 3 * 86400e3), aid]);
  await ctx.db.run('UPDATE BedMoves SET FromAt = ? WHERE AdmissionId = ?', [new Date(Date.now() - 3 * 86400e3), aid]);
  let b = (await acc.get('/api/tickets/board')).body;
  let me = b.admissions.find((x) => x.id === aid);
  assert.equal(me.ticketsToday, 0);
  assert.equal(me.missing.length, 3);
  const y = me.missing[2];
  await acc.post(`/api/tickets/adm/${aid}`, { date: y, lines: [{ cat: 'supply', stockItemId: item('شاش معقم').id }] });
  await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'supply', stockItemId: item('شاش معقم').id }] });
  b = (await acc.get('/api/tickets/board')).body;
  me = b.admissions.find((x) => x.id === aid);
  assert.equal(me.ticketsToday, 1);
  assert.equal(me.missing.length, 2);
  assert.ok(b.counts.noTicketToday >= 1);
  // لوحة الأسرّة بتعلّم المريض
  const board = (await rec.get('/api/admissions/beds/board')).body;
  const bed = board.floors.flatMap((f) => f.rooms.flatMap((r) => r.beds)).find((x) => x.admission?.id === aid);
  assert.equal(bed.admission.ticketToday, true);
  // الرئيسية
  assert.ok((await acc.get('/api/home/summary')).body.tickets.active >= 1);
});

test('قفل التذكرة من غير خزينة: الحساب يتجمد، والاستقبال يخرّج ويقبض', async () => {
  const { aid } = await admit();
  await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'drug', stockItemId: item('أوميبرازول 40 مجم').id, qty: 2 }] });
  const c = await acc.post(`/api/tickets/adm/${aid}/close`, {});
  assert.equal(c.status, 200);
  assert.equal(c.body.admission.bill.status, 'closed');
  assert.equal(c.body.order, null);
  // بعد القفل: مفيش إضافة ولا شيل ولا تحويل
  assert.equal((await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'supply', stockItemId: item('شاش معقم').id }] })).status, 409);
  const it = c.body.items.find((i) => i.cat === 'drug');
  assert.equal((await acc.del(`/api/tickets/adm/${aid}/items/${it.id}`, { reason: 'تجربة' })).status, 409);
  assert.equal((await acc.post(`/api/tickets/adm/${aid}/close`, {})).status, 409);
  // الاستقبال يخرّج
  const pv = (await rec.get(`/api/admissions/${aid}/discharge-preview`)).body;
  const R = Math.round((pv.totals.patient - pv.totals.paid) * 100) / 100;
  const body = R > 0 ? { cash: R } : {};
  const d = await rec.post(`/api/admissions/${aid}/discharge`, body);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.admission.status, 'discharged');
});

test('فتح التذكرة: مشرف الحسابات أو المدير بس، وإذن الخروج المستني بيتلغي', async () => {
  // خزينة شغالة
  assert.equal((await cas.post('/api/shifts/open', {})).status < 300, true);
  const { aid } = await admit({ cash: 0 });
  // التأمين اتعمل إذن لأن الخزينة شغالة
  const det = (await acc.get(`/api/tickets/adm/${aid}`)).body;
  for (const o of det.orders) await cas.post(`/api/orders/${o.id}/collect`, { cash: o.amount });
  await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'visit', serviceId: svc['IP-007'].id, doctorId: docs[0].id, qty: 6 }] });
  const c = await acc.post(`/api/tickets/adm/${aid}/close`, { note: 'خروج بأمر الدكتور' });
  assert.equal(c.status, 200);
  assert.ok(c.body.order, 'إذن الخروج اتعمل للخزينة لوحده');
  assert.equal(c.body.order.kind, 'discharge');
  assert.equal(c.body.order.amount, c.body.totals.balance);
  // الحسابات العادية ماتفتحش
  assert.equal((await acc.post(`/api/tickets/adm/${aid}/reopen`, { reason: 'نسينا دوا' })).status, 403);
  assert.equal((await sup.post(`/api/tickets/adm/${aid}/reopen`, {})).status, 400);
  const ro = await sup.post(`/api/tickets/adm/${aid}/reopen`, { reason: 'نسينا دوا' });
  assert.equal(ro.status, 200);
  assert.equal(ro.body.admission.bill.status, 'open');
  assert.equal(ro.body.admission.bill.reopened, 1);
  assert.equal(ro.body.orders.length, 0);
  assert.notEqual((await cas.post(`/api/orders/${c.body.order.id}/collect`, { cash: c.body.order.amount })).status, 201);
  // نضيف ونقفل تاني والخزينة تحصّل
  await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'drug', stockItemId: item('باراسيتامول 1 جم محلول').id }] });
  const c2 = await acc.post(`/api/tickets/adm/${aid}/close`, {});
  assert.equal(c2.body.order.amount, c.body.order.amount + 70);
  const x = await cas.post(`/api/orders/${c2.body.order.id}/collect`, c2.body.order.amount > 0 ? { cash: c2.body.order.amount, manualNo: 'K-77' } : { manualNo: 'K-77' });
  assert.equal(x.status, 201, JSON.stringify(x.body));
  const fin = (await acc.get(`/api/tickets/adm/${aid}`)).body;
  assert.equal(fin.admission.status, 'discharged');
  assert.equal(fin.totals.balance, 0);
  // الفاتورة الإجمالية والتفصيلية
  const sum = await mgr.get(`/print/admission/${aid}?mode=summary`);
  assert.equal(sum.status, 200);
  const txt = sum.body.toString();
  assert.match(txt, /الزيارات/);
  assert.match(txt, /الأدوية/);
  const det2 = (await mgr.get(`/print/admission/${aid}?mode=detail`)).body.toString();
  assert.match(det2, /باراسيتامول/);
  assert.match(det2, /زيارة استشاري/);
});

test('المستحقات اللاحقة: المريض يدفع أو تتحمّل على موظف أو قسم', async () => {
  const { aid } = await admit();
  // لسه داخل: مرفوض
  assert.equal((await acc.post('/api/tickets/late', { admissionId: aid, cat: 'supply', stockItemId: item('شاش معقم').id, reason: 'اتنسى' })).status, 409);
  // إذن التأمين لسه في الخزينة: مينفعش تتقفل
  const dep = (await acc.get(`/api/tickets/adm/${aid}`)).body.orders[0];
  assert.equal((await acc.post(`/api/tickets/adm/${aid}/close`, {})).status, 409);
  await cas.post(`/api/orders/${dep.id}/collect`, { cash: dep.amount });
  const cl = await acc.post(`/api/tickets/adm/${aid}/close`, {});
  assert.equal(cl.status, 200);
  const o = cl.body.order;
  assert.ok(o);
  assert.equal((await cas.post(`/api/orders/${o.id}/collect`, o.amount > 0 ? { cash: o.amount } : {})).status, 201);
  assert.equal((await acc.get(`/api/tickets/adm/${aid}`)).body.admission.status, 'discharged');
  const found = (await acc.get('/api/tickets/late/admissions?q=' + encodeURIComponent('تذكرة رقم'))).body.admissions;
  assert.ok(found.some((x) => x.id === aid));
  assert.equal((await acc.post('/api/tickets/late', { admissionId: aid, cat: 'supply', stockItemId: item('قسطرة بولية فولي').id })).status, 400); // السبب إجباري
  const l1 = await acc.post('/api/tickets/late', { admissionId: aid, cat: 'supply', stockItemId: item('قسطرة بولية فولي').id, qty: 2, reason: 'التمريض نسي يكتبها' });
  assert.equal(l1.status, 201);
  assert.equal(l1.body.late.amount, 70);
  const l2 = await acc.post('/api/tickets/late', { admissionId: aid, cat: 'drug', stockItemId: item('ألبومين 20% 50 مل').id, reason: 'ما اتكتبش في التذكرة' });
  const l3 = await acc.post('/api/tickets/late', { admissionId: aid, cat: 'service', serviceId: svc['IP-004'].id, reason: 'رسم قلب ما اتسجلش' });
  // الحسابات العادية ماتاخدش قرار
  assert.equal((await acc.post(`/api/tickets/late/${l1.body.late.id}/decide`, { to: 'patient' })).status, 403);
  // المريض وافق يدفع → إذن للخزينة
  const d1 = await sup.post(`/api/tickets/late/${l1.body.late.id}/decide`, { to: 'patient', note: 'اتصلنا بابنه ووافق' });
  assert.equal(d1.status, 200);
  assert.equal(d1.body.late.status, 'billed');
  assert.equal(d1.body.order.amount, 70);
  assert.equal((await cas.post(`/api/orders/${d1.body.order.id}/collect`, { cash: 70 })).status, 201);
  // على موظف
  assert.equal((await sup.post(`/api/tickets/late/${l2.body.late.id}/decide`, { to: 'employee' })).status, 400);
  const d2 = await sup.post(`/api/tickets/late/${l2.body.late.id}/decide`, { to: 'employee', name: 'ممرضة الدور الرابع', note: 'رفض يدفع' });
  assert.equal(d2.body.late.status, 'charged');
  const d3 = await sup.post(`/api/tickets/late/${l3.body.late.id}/decide`, { to: 'dept', name: 'تمريض الدور' });
  assert.equal(d3.body.late.chargeTo, 'dept');
  assert.equal((await sup.post(`/api/tickets/late/${l3.body.late.id}/decide`, { to: 'cancel', note: 'مرة تانية' })).status, 409);
  const list = (await sup.get('/api/tickets/late')).body;
  assert.equal(list.summary.charged.n, 2);
  assert.equal(list.summary.billed.amount, 70);
  assert.equal(list.summary.byWho[0].name, 'ممرضة الدور الرابع');
  assert.equal(list.summary.byWho[0].amount, 950);
  // حساب المريض فيه البند اللاحق ومتسدد
  const fin = (await rec.get(`/api/admissions/${aid}`)).body;
  assert.ok(fin.items.some((i) => i.note === `مستحق لاحق رقم ${l1.body.late.no}`));
  assert.equal(fin.totals.balance, 0);
});

test('الأصناف: إضافة وتعديل (المدير ومشرف الحسابات)، وتصدير واستيراد إكسل', async () => {
  assert.equal((await acc.post('/api/tickets/items', { name: 'صنف', kind: 'drug', price: 5 })).status, 403);
  const bad = await sup.post('/api/tickets/items', { name: 'x', kind: 'zz', price: -1 });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.kind && bad.body.errors.price && bad.body.errors.name);
  const c = await sup.post('/api/tickets/items', { name: 'فيتامين ب مركب', kind: 'drug', unit: 'أمبول', price: 12 });
  assert.equal(c.status, 201);
  assert.match(c.body.item.code, /^D-\d{4}$/);
  const u = await mgr.put(`/api/tickets/items/${c.body.item.id}`, { ...c.body.item, price: 14, active: false });
  assert.equal(u.body.item.price, 14);
  assert.ok(!(await acc.get('/api/tickets/items')).body.items.some((x) => x.id === c.body.item.id)); // الموقوف مش بيظهر في التذكرة
  // تصدير
  const ex = await mgr.get('/api/tickets/items/export');
  assert.equal(ex.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.body);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('B1').value, 'اسم الصنف');
  // نعدّل سعر صنف ونضيف صنف جديد ونرفع
  for (let i = 2; i <= ws.rowCount; i++) if (ws.getCell('B' + i).value === 'جوانتي فحص') ws.getCell('E' + i).value = 3;
  ws.addRow(['', 'لاصق جروح', 'مستلزم', 'علبة', 40, '', 'نعم']);
  ws.addRow(['', 'صنف غلط', 'حاجة', '', 'abc', '', '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const pv = await mgr.raw('/api/tickets/items/import', buf);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.counts.new, 1);
  assert.equal(pv.body.counts.update, 1);
  assert.equal(pv.body.counts.error, 1);
  assert.equal((await mgr.raw('/api/tickets/items/import?mode=apply', buf)).status, 400);
  ws.spliceRows(ws.rowCount, 1);
  const ok = await mgr.raw('/api/tickets/items/import?mode=apply', Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.applied, { created: 1, updated: 1 });
  const all = (await acc.get('/api/tickets/items')).body.items;
  assert.equal(all.find((x) => x.name === 'جوانتي فحص').price, 3);
  assert.ok(all.some((x) => x.name === 'لاصق جروح' && x.kind === 'supply'));
});

test('تعاقد بيغطي الأدوية: نصيب الشركة على الأدوية والمستلزمات', async () => {
  const payers = (await rec.get('/api/payers')).body.payers;
  const py = payers.find((x) => x.name === 'هيئة قناة السويس');
  const tier = py.tiers.find((t) => t.name === 'موظف');
  const { aid } = await admit({ payer: { payerId: py.id, tierId: tier.id, cardNo: 'SC-1' }, approvalNo: 'A-1', deposit: 0, cash: 0 });
  void aid;
  const r = await acc.post(`/api/tickets/adm/${aid}`, { lines: [{ cat: 'drug', stockItemId: item('سيفوتاكسيم 1 جم').id, qty: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ln = r.body.items.find((i) => i.cat === 'drug');
  assert.equal(ln.payerAmount, 120);
  assert.equal(ln.patientAmount, 0);
});

test('الحفظ أول بأول: كل سطر بيتسجل لوحده في نفس الدفعة، والعدد بيتعدل، والسطر الجديد بيتشال من غير سبب', async () => {
  const { aid } = await admit();
  const l1 = await acc.post(`/api/tickets/adm/${aid}/lines`, { paperNo: '77', line: { cat: 'drug', stockItemId: item('سيفترياكسون 1 جم').id, qty: 1 } });
  assert.equal(l1.status, 201, JSON.stringify(l1.body));
  const tid = l1.body.ticket.id;
  const l2 = await acc.post(`/api/tickets/adm/${aid}/lines`, { ticketId: tid, line: { cat: 'supply', stockItemId: item('كانيولا 20G').id } });
  assert.equal(l2.body.ticket.id, tid); // نفس الدفعة
  const l3 = await acc.post(`/api/tickets/adm/${aid}/lines`, { ticketId: tid, line: { cat: 'fee', serviceId: svc['OR-006'].id, doctorId: docs[0].id, price: 2000 } });
  assert.equal(l3.body.tickets.length, 1);
  // العدد
  const up = await acc.patch(`/api/tickets/adm/${aid}/items/${l1.body.itemId}`, { qty: 3 });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.items.find((i) => i.id === l1.body.itemId).amount, 255);
  assert.equal(up.body.tickets[0].total, 255 + 18 + 2000);
  // المبلغ المفتوح بس
  assert.equal((await acc.patch(`/api/tickets/adm/${aid}/items/${l2.body.itemId}`, { price: 50 })).status, 400);
  const pr = await acc.patch(`/api/tickets/adm/${aid}/items/${l3.body.itemId}`, { price: 2400 });
  assert.equal(pr.body.totals.byCat.fee, 2400);
  assert.equal((await acc.patch(`/api/tickets/adm/${aid}/items/${l1.body.itemId}`, { qty: 0 })).status, 400);
  // موظف تاني مايعدّلش سطر غيره (المشرف يقدر)
  const acc2 = sup;
  assert.equal((await acc2.patch(`/api/tickets/adm/${aid}/items/${l1.body.itemId}`, { qty: 2 })).status, 200);
  // شيل سطر لسه مكتوب: من غير سبب
  const rm = await acc.del(`/api/tickets/adm/${aid}/items/${l2.body.itemId}`, {});
  assert.equal(rm.status, 200);
  assert.equal(rm.body.items.find((i) => i.id === l2.body.itemId).voidReason, 'اتشال وقت الكتابة');
  // رقم الورقة بعدين
  const pp = await acc.put(`/api/tickets/adm/${aid}/t/${tid}`, { paperNo: '1600' });
  assert.equal(pp.body.tickets[0].paperNo, '1600');
  // دفعة الموظف التاني منفصلة، ويوم تاني = دفعة جديدة
  const o = await sup.post(`/api/tickets/adm/${aid}/lines`, { ticketId: tid, line: { cat: 'supply', stockItemId: item('شاش معقم').id } });
  assert.notEqual(o.body.ticket.id, tid);
  // بعد القفل مفيش تعديل
  for (const od of (await acc.get(`/api/tickets/adm/${aid}`)).body.orders) await cas.post(`/api/orders/${od.id}/collect`, { cash: od.amount });
  assert.equal((await acc.post(`/api/tickets/adm/${aid}/close`, {})).status, 200);
  assert.equal((await acc.patch(`/api/tickets/adm/${aid}/items/${l1.body.itemId}`, { qty: 5 })).status, 409);
  assert.equal((await acc.post(`/api/tickets/adm/${aid}/lines`, { line: { cat: 'supply', stockItemId: item('شاش معقم').id } })).status, 409);
});

test('أسعار الأدوار: نفس الخدمة والدرجة بسعر الدور اللي المريض فيه، وسعر الشركة الأول', async () => {
  const o = (await mgr.get('/api/admin/floor-prices')).body;
  assert.ok(o.floors.length && o.services.some((s) => s.code === 'IP-002') && !o.services.some((s) => s.cat === 'fee'));
  assert.equal((await acc.get('/api/admin/floor-prices')).status, 403);
  // أوضة في الدور الرابع وأوضة في الدور التامن من نفس الدرجة؟ نستخدم أي دورين فيهم أسرّة فاضية
  const board = (await rec.get('/api/admissions/beds/board')).body;
  const freeIn = (fno) => { for (const f of board.floors) if (f.no === fno) for (const r of f.rooms) for (const b of r.beds) if (b.status === 'free' && r.cls.kind === 'ward') return { b, r, f }; };
  const f4 = freeIn(4), f8 = freeIn(8);
  assert.ok(f4 && f8);
  const svcId = svc['IP-002'].id; // أكسجين 50
  assert.equal((await mgr.put('/api/admin/floor-prices', { type: 'service', floorId: f8.f.id, refId: svcId, price: 40 })).body.changed, true);
  await mgr.put('/api/admin/floor-prices', { type: 'service', floorId: f4.f.id, refId: svcId, price: 60 });
  await mgr.put('/api/admin/floor-prices', { type: 'class', floorId: f8.f.id, refId: f8.r.cls.id, price: 2222 });
  assert.equal((await mgr.put('/api/admin/floor-prices', { type: 'service', floorId: f8.f.id, refId: svc['OR-006'].id, price: 10 })).status, 404); // الأتعاب مالهاش سعر دور
  // لوحة الأسرّة بتعرض سعر الدور
  const b2 = (await rec.get('/api/admissions/beds/board')).body;
  assert.equal(b2.floors.find((f) => f.id === f8.f.id).rooms.find((r) => r.id === f8.r.id).cls.nightPrice, 2222);
  // دخول في التامن
  n++;
  const p = (await rec.post('/api/patients', { name: `مريض الدور التامن ${n} علي`, phone: `0108888${String(n).padStart(4, '0')}`, ageYears: 40, sex: 'M', address: 'دمياط', nationalId: `276010111${String(n).padStart(3, '0')}1${n % 10}`, emergencyName: 'ابنه', emergencyPhone: '01012345678', confirmDuplicatePhone: true })).body.patient;
  const a = await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: f8.b.id, doctorId: docs[0].id, deposit: f8.r.cls.deposit, cash: f8.r.cls.deposit });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const aid = a.body.admission.id;
  for (const od of a.body.orders || []) await cas.post(`/api/orders/${od.id}/collect`, { cash: od.amount });
  assert.equal(a.body.items.find((i) => i.kind === 'night').unitPrice, 2222);
  const l = await acc.post(`/api/tickets/adm/${aid}/lines`, { line: { cat: 'service', serviceId: svcId } });
  assert.equal(l.body.items.find((i) => i.id === l.body.itemId).unitPrice, 40);
  assert.equal(l.body.floorSvc[f8.f.id][svcId], 40);
  // الأتعاب بسعرها في أي دور
  const fee = await acc.post(`/api/tickets/adm/${aid}/lines`, { ticketId: l.body.ticket.id, line: { cat: 'visit', serviceId: svc['IP-007'].id, doctorId: docs[0].id } });
  assert.equal(fee.body.items.find((i) => i.id === fee.body.itemId).unitPrice, 500);
  // تحويل للرابع: البند الجديد بسعر الرابع
  const tr = await rec.post(`/api/admissions/${aid}/transfer`, { bedId: f4.b.id, reason: 'طلب المريض' });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  const l2 = await acc.post(`/api/tickets/adm/${aid}/lines`, { ticketId: l.body.ticket.id, line: { cat: 'service', serviceId: svcId } });
  assert.equal(l2.body.items.find((i) => i.id === l2.body.itemId).unitPrice, 60);
  // ليلة النهارده بسعر الدرجة في الرابع (الأساسي)
  assert.equal(l2.body.items.find((i) => i.kind === 'night' && i.status === 'active').unitPrice, f4.r.cls.nightPrice);
  // إكسل: تصدير وتعديل واستيراد
  const ex = await mgr.get('/api/admin/floor-prices/export');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(ex.body);
  const ws = wb.getWorksheet('الخدمات');
  let col = 0; ws.getRow(1).eachCell((c, i) => { if (c.text === `الدور ${f8.f.no}`) col = i; });
  for (let i = 2; i <= ws.rowCount; i++) if (ws.getCell(i, 1).text === 'IP-003') ws.getCell(i, col).value = 77;
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const pv = await mgr.raw('/api/admin/floor-prices/import', buf);
  assert.equal(pv.body.count, 1);
  assert.equal(pv.body.changes[0].now, 77);
  const ap = await mgr.raw('/api/admin/floor-prices/import?mode=apply', buf);
  assert.equal(ap.body.servicePrices[`${f8.f.id}|${svc['IP-003'].id}`], 77);
  // فاضي = يرجع للأساسي
  await mgr.put('/api/admin/floor-prices', { type: 'service', floorId: f4.f.id, refId: svcId, price: '' });
  assert.equal((await mgr.get('/api/admin/floor-prices')).body.servicePrices[`${f4.f.id}|${svcId}`], undefined);
});
