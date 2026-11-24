// اختبارات حسابات التعاقدات: الحالات، المراجعة، المطالبة الشهرية، الشيك والمرفوضات
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { seedDemo } from '../scripts/seed-demo.js';

let ctx, base, rec, mgr, rev, cl, svc, docs, payers, board;
async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'Safa@2026' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type: ct };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}
let n = 0;
async function patient(extra = {}) {
  n++;
  return (await rec.post('/api/patients', { name: `مريض مطالبة رقم ${n} أحمد`, phone: `0106666${String(n).padStart(4, '0')}`, ageYears: 40, sex: 'M', confirmDuplicatePhone: true, ...extra })).body.patient;
}
const P = (name) => payers.find((p) => p.name === name);
const T = (name, tier) => P(name).tiers.find((t) => t.name === tier);
const period = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }).slice(0, 7);
const ENG = () => P('نقابة المهندسين').id;

before(async () => {
  ctx = await start({ port: 0, db: { driver: 'sqlite', sqlite: { file: ':memory:' } } });
  await seedDemo(ctx.db);
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  rec = client(await login('reception'));
  mgr = client(await login('manager'));
  await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' });
  rev = client(await login('review'));
  cl = client(await login('claims'));
  svc = Object.fromEntries((await rec.get('/api/catalog/services')).body.services.map((s) => [s.code, s]));
  docs = (await rec.get('/api/catalog/doctors')).body.doctors;
  payers = (await rec.get('/api/payers?usable=1')).body.payers;
  board = (await rec.get('/api/admissions/beds/board')).body;
  await mgr.put('/api/admin/settings', { checkoutTime: '23:59' });
});
after(async () => { ctx.server.close(); await ctx.db.close(); });

let visitCase, admCase, claimId;
test('الحالات بتتعمل لوحدها من الزيارات والدخول اللي على الجهة، والتشخيص من الاستقبال', async () => {
  // زيارتين معمل على نقابة المهندسين (50%)
  for (const card of ['ENG-1', 'ENG-2']) {
    const p = await patient();
    await rec.put(`/api/patients/${p.id}/payer`, { payerId: ENG(), tierId: T('نقابة المهندسين', 'كارنيه ب').id, cardNo: card });
    const v = (await rec.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
    if (card === 'ENG-1') assert.equal((await rec.put(`/api/visits/${v.visit.id}/diagnosis`, { diagnosis: 'أنيميا' })).body.visit.diagnosis, 'أنيميا');
    const d = (await rec.post(`/api/visits/${v.visit.id}/items`, { serviceId: svc['LAB-001'].id })).body;
    assert.equal((await rec.post(`/api/visits/${v.visit.id}/pay`, { itemIds: [d.items[0].id], cash: d.items[0].patientAmount })).status, 201);
  }
  // دخول 100% وخروج
  const p = await patient({ nationalId: '29002021100046', address: 'دمياط', emergencyName: 'أبوه', emergencyPhone: '01011111112' });
  const bed = board.floors.flatMap((f) => f.rooms).find((r) => r.no === '302').beds[0];
  const a = (await rec.post('/api/admissions', { diagnosis: 'التهاب رئوي', patientId: p.id, type: 'inpatient', bedId: bed.id, doctorId: docs[0].id, deposit: 0, payer: { payerId: P('هيئة قناة السويس').id, tierId: T('هيئة قناة السويس', 'موظف').id, cardNo: 'SC-5' }, diagnosis: 'التهاب رئوي' })).body;
  assert.equal(a.admission.diagnosis, 'التهاب رئوي');
  const ap = (await rev.get('/api/approvals?status=pending')).body.approvals.find((x) => x.scope === 'admission' && x.admissionId === a.admission.id);
  await rev.post(`/api/approvals/${ap.id}/approve`, { no: 'SC-AP-1' });
  const dis = await rec.post(`/api/admissions/${a.admission.id}/discharge`, {});
  assert.equal(dis.status, 201, JSON.stringify(dis.body));

  assert.equal((await rec.get(`/api/claims/overview?period=${period}`)).status, 403);
  const ov = (await cl.get(`/api/claims/overview?period=${period}`)).body;
  const eng = ov.payers.find((x) => x.payer.id === ENG());
  assert.equal(eng.visits, 2);
  assert.equal(eng.amount, 108);
  const sc = ov.payers.find((x) => x.payer.name === 'هيئة قناة السويس');
  assert.equal(sc.admissions, 1);
  const cs = (await cl.get(`/api/claims/cases?payerId=${ENG()}&period=${period}`)).body.cases;
  assert.equal(cs.length, 2);
  const bad = cs.find((c) => !c.diagnosis);
  assert.deepEqual(bad.flags, ['التشخيص ناقص']);
  assert.equal(cs.find((c) => c.diagnosis).flags.length, 0);
  visitCase = bad.id;
  admCase = (await cl.get(`/api/claims/cases?payerId=${sc.payer.id}&period=${period}`)).body.cases[0].id;
});

test('المراجعة: ملاحظة بترجع للاستقبال، والاستقبال يصلّح، والتسوية والتأجيل', async () => {
  assert.equal((await cl.post(`/api/claims/cases/${visitCase}/status`, { status: 'note' })).status, 400);
  await cl.post(`/api/claims/cases/${visitCase}/status`, { status: 'note', note: 'هاتوا صورة الكارنيه والتشخيص' });
  const notes = (await rec.get('/api/claims/notes')).body.cases;
  assert.equal(notes.length, 1);
  // الاستقبال يكمّل
  await rec.put(`/api/claims/cases/${visitCase}`, { cardNo: 'ENG-٩٩', diagnosis: 'متابعة' });
  const f = await fetch(base + `/api/claims/cases/${visitCase}/files?label=${encodeURIComponent('صورة الكارنيه')}`, { method: 'POST', headers: { cookie: await login('reception') }, body: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200)]) });
  assert.equal(f.status, 200);
  const fx = (await rec.post(`/api/claims/cases/${visitCase}/fixed`)).body;
  assert.equal(fx.case.status, 'pending');
  assert.equal(fx.case.cardNo, 'ENG-99');
  assert.equal(fx.files.length, 1);
  // تسوية: الشركة هتدفع 50 بس بدل 54 (المستشفى بتتحمل الفرق)
  const it = fx.items[0];
  assert.equal((await cl.post(`/api/claims/cases/${visitCase}/adjust`, { itemId: it.id, amount: 50 })).status, 400);
  const adj = (await cl.post(`/api/claims/cases/${visitCase}/adjust`, { itemId: it.id, amount: 50, reason: 'سعر التعاقد القديم' })).body;
  assert.equal(adj.items[0].payer, 50);
  assert.equal(adj.adjustments.length, 1);
  // تأجيل ورجوع
  assert.equal((await cl.post(`/api/claims/cases/${visitCase}/defer`)).body.case.deferred, true);
  assert.equal((await cl.post(`/api/claims/cases/${visitCase}/defer`, { undo: true })).body.case.deferred, false);
  for (const c of (await cl.get(`/api/claims/cases?payerId=${ENG()}&period=${period}`)).body.cases) await cl.post(`/api/claims/cases/${c.id}/status`, { status: 'ok' });
});

test('المطالبة: مسودة بتتحدث، Cover وتفصيلي، اتبعتت فاتقفلت، والفرق بعدها بيروح للمطالبة اللي بعدها', async () => {
  assert.equal((await rec.post('/api/claims', { payerId: ENG(), period })).status, 403);
  const c = await cl.post('/api/claims', { payerId: ENG(), period });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  claimId = c.body.claim.id;
  assert.equal(c.body.totals.total, 104); // 54 + 50
  assert.equal(c.body.totals.visits, 2);
  assert.match(c.body.totals.words, /مائة وأربعة/);
  // تسوية تانية والمسودة تتحدث لوحدها
  const it = (await cl.get(`/api/claims/cases/${visitCase}`)).body.items[0];
  await cl.post(`/api/claims/cases/${visitCase}/adjust`, { itemId: it.id, amount: 52, reason: 'اتفاق' });
  assert.equal((await cl.get(`/api/claims/${claimId}`)).body.totals.total, 106);
  // الطباعة والإكسل
  const pr = await cl.get(`/print/claim/${claimId}`);
  assert.equal(pr.status, 200);
  assert.ok(pr.body.toString().includes('نقابة المهندسين') && pr.body.toString().includes('ENG-99'));
  const x = await cl.get(`/api/claims/${claimId}?format=xlsx`);
  assert.match(x.type, /spreadsheet/);
  const s = await cl.post(`/api/claims/${claimId}/send`, { issueDate: '2026-12-01' });
  assert.equal(s.body.claim.status, 'sent');
  assert.equal(s.body.claim.issueDate, '2026-12-01');
  // بعد الإرسال: تسوية جديدة = فرق في المطالبة اللي بعدها
  await cl.post(`/api/claims/cases/${visitCase}/adjust`, { itemId: it.id, amount: 54, reason: 'الشركة وافقت على السعر' });
  assert.equal((await cl.get(`/api/claims/${claimId}`)).body.totals.total, 106);
  const cs = (await cl.get(`/api/claims/cases?payerId=${ENG()}&period=${period}`)).body.cases.find((x) => x.id === visitCase);
  assert.equal(cs.outstanding, 2);
  assert.equal(cs.afterClaim, true);
  const c2 = await cl.post('/api/claims', { payerId: ENG(), period });
  assert.equal(c2.status, 201);
  assert.equal(c2.body.claim.supplement, true);
  assert.equal(c2.body.totals.total, 2);
  assert.ok(c2.body.cases[0].lines[0].text.startsWith('فرق'));
  assert.equal((await cl.del(`/api/claims/${c2.body.claim.id}`)).status, 200);
});

test('الشيك والمرفوضات: الشركة دفعت جزء ورفضت بند، والمستشفى بتتحمله', async () => {
  const d = (await cl.get(`/api/claims/${claimId}`)).body;
  const line = d.cases.flatMap((c) => c.lines).find((l) => l.amount === 54);
  assert.equal((await cl.put(`/api/claims/${claimId}/lines/${line.id}`, { rejected: 54 })).status, 400);
  const rj = (await cl.put(`/api/claims/${claimId}/lines/${line.id}`, { rejected: 54, reason: 'مش مغطى في العقد' })).body;
  assert.equal(rj.totals.rejected, 54);
  assert.equal(rj.claim.status, 'partial');
  assert.equal((await cl.post(`/api/claims/${claimId}/payments`, { chequeNo: '1', amount: 1000 })).status, 400);
  const p = (await cl.post(`/api/claims/${claimId}/payments`, { chequeNo: '778812', bank: 'بنك مصر', amount: 52 })).body;
  assert.equal(p.claim.status, 'closed');
  assert.equal(p.totals.left, 0);
  assert.equal((await mgr.post(`/api/claims/${claimId}/reopen`, { reason: 'تجربة' })).status, 409);
  const rep = (await cl.get('/api/claims/reports/rejections')).body;
  assert.equal(rep.total, 54);
  assert.equal(rep.byReason[0].name, 'مش مغطى في العقد');
  const list = (await cl.get('/api/claims/list')).body.claims;
  assert.ok(list.some((x) => x.id === claimId && x.status === 'closed'));
});

test('الداخلي في مطالبة جهته، والمدير يفتح المطالبة المبعوتة لو مفيهاش شيك', async () => {
  await cl.post(`/api/claims/cases/${admCase}/status`, { status: 'ok' });
  const sc = P('هيئة قناة السويس').id;
  const c = (await cl.post('/api/claims', { payerId: sc, period })).body;
  assert.equal(c.totals.admissions, 1);
  assert.ok(c.totals.total > 0);
  assert.ok(c.cases[0].lines.every((l) => l.date));
  await cl.post(`/api/claims/${c.claim.id}/send`);
  assert.equal((await cl.post(`/api/claims/${c.claim.id}/reopen`, { reason: 'غلط' })).status, 403);
  assert.equal((await mgr.post(`/api/claims/${c.claim.id}/reopen`, { reason: 'نسينا حالة' })).body.claim.status, 'draft');
});
