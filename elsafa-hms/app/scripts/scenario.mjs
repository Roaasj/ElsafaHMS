// سيناريو ضغط ودورة مستندية كاملة: تسجيل مرضى وعيادات وداخلي بعدة مستخدمين في نفس الوقت، إلغاء إيصالات بعد الطباعة،
// خزينة وورديات، مخازن، وحسابات (ترحيل لدفتر الأستاذ). بيشتغل على نسخة تجريبية في الذاكرة (الافتراضي)، أو على سيرفر شغّال:
//   node scripts/scenario.mjs                      ← قاعدة SQLite في الذاكرة
//   BASE_URL=http://localhost:3000 PW='...' node scripts/scenario.mjs   ← سيرفر حقيقي (استخدم نسخة تجريبية من القاعدة!)
// أسماء المستخدمين المتوقعة هي بتاعة بيانات التجربة (reception, cashier, manager, store, fin ...). لو القاعدة فيها مستخدمين تانيين: USERS='{"reception":"اسم","cashier":"..."}'
import { start } from '../src/server.js';
import { seedDemo } from './seed-demo.js';
import { loadConfig } from '../src/config.js';

const PW = process.env.PW || 'Safa@2026';
const NAMES = { manager: 'manager', reception: 'reception', cashier: 'cashier', cashier2: 'cashier2', store: 'store', fin: 'fin', ...(process.env.USERS ? JSON.parse(process.env.USERS) : {}) };
const WRITERS = Number(process.env.WRITERS || 8), PER = Number(process.env.PER || 12);
let base, ctx;
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`); };

async function login(u) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: NAMES[u] || u, password: PW }) });
  if (!r.ok) throw new Error(`دخول ${u} فشل: ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const client = (cookie) => {
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
};
const uniq = (a) => new Set(a).size === a.length;
let seq = 0;
const uid = () => ++seq;
const phone = () => `010${String(Date.now() % 1e5).padStart(5, '0')}${String(uid()).padStart(3, '0')}`.slice(0, 11);
const mkPatient = (c, tag, full = false) => {
  const n = uid();
  return c.post('/api/patients', { name: `مريض ${tag} رقم ${n} سعيد محمد`, phone: `01${String(1000000000 + n * 7919).slice(-9)}`, ageYears: 20 + (n % 50), sex: n % 2 ? 'M' : 'F', address: 'دمياط',
    ...(full ? { nationalId: `290020211${String(n).padStart(5, '0')}`, emergencyName: 'قريب المريض', emergencyPhone: `01${String(2000000000 + n * 13).slice(-9)}` } : {}), confirmDuplicatePhone: true });
};

async function main() {
  if (process.env.BASE_URL) base = process.env.BASE_URL.replace(/\/+$/, '');
  else {
    let dbCfg = { driver: 'sqlite', sqlite: { file: ':memory:' } };
    if (process.env.STRESS_MSSQL) {
      // SQL Server حقيقي لكن على قاعدة تجربة بس: الاسم لازم يحتوي Stress أو Test عشان ما نلمسش قاعدة التشغيل
      dbCfg = loadConfig().db;
      if (dbCfg.driver !== 'mssql' || !/(stress|test)/i.test(String(dbCfg.mssql.database))) { console.error('رفضت التشغيل: اسم القاعدة لازم يحتوي Stress أو Test:', dbCfg.mssql?.database); process.exit(3); }
      console.log('— SQL Server · قاعدة', dbCfg.mssql.database);
    }
    ctx = await start({ port: 0, db: dbCfg });
    await seedDemo(ctx.db);
    base = `http://127.0.0.1:${ctx.server.address().port}`;
  }
  console.log('— الهدف:', base);
  const mgr = client(await login('manager'));
  await mgr.put('/api/admin/ticket-settings', { ticketMode: 'off' }).catch(() => {});
  await mgr.put('/api/admin/settings', { checkoutTime: '23:59' }).catch(() => {});
  check('تفعيل القيود المحاسبية للتجربة', (await mgr.put('/api/ledger/settings', { enabled: true })).status === 200);

  const recs = await Promise.all(Array.from({ length: WRITERS }, async () => client(await login('reception'))));
  const svcs = (await recs[0].get('/api/catalog/services')).body.services;
  const docs = (await recs[0].get('/api/catalog/doctors')).body.doctors;
  const clinicSvc = svcs.find((s) => s.dept === 'clinic' && s.hasDoctor) || svcs.find((s) => s.dept === 'clinic');
  const labSvc = svcs.find((s) => s.dept === 'lab');
  const doc = docs[0];

  // 1) تسجيل مرضى بالتوازي
  const regs = await Promise.all(recs.flatMap((c, i) => Array.from({ length: PER }, () => mkPatient(c, `ت${i}`))));
  const okRegs = regs.filter((r) => r.status === 201);
  const nos = okRegs.map((r) => r.body.patient.no);
  check(`تسجيل ${WRITERS * PER} مريض بالتوازي: الكل اتسجّل`, okRegs.length === WRITERS * PER, `${okRegs.length}/${WRITERS * PER}`);
  check('أرقام الملفات مش متكررة', uniq(nos));
  const sorted = [...nos].sort((a, b) => a - b);
  check('أرقام الملفات متصلة من غير فجوات', sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1));
  const patients = okRegs.map((r) => r.body.patient);

  // 2) كشف عيادة + تحاليل بالتوازي، والدفع عند الاستقبال (من غير خزينة مفتوحة)
  const made = await Promise.all(patients.map(async (p, i) => {
    const c = recs[i % recs.length];
    const v = await c.post('/api/visits', { patientId: p.id, type: 'clinic' });
    if (v.status !== 201 && v.status !== 200) return { err: `visit ${v.status} ${JSON.stringify(v.body).slice(0, 120)}` };
    const vid = v.body.visit.id;
    const it1 = await c.post(`/api/visits/${vid}/items`, { serviceId: clinicSvc.id, doctorId: clinicSvc.hasDoctor ? doc.id : undefined });
    if (it1.status !== 201 && it1.status !== 200) return { err: `item ${it1.status} ${JSON.stringify(it1.body).slice(0, 120)}` };
    const it2 = await c.post(`/api/visits/${vid}/items`, { serviceId: labSvc.id });
    const items = (it2.body.items || it1.body.items);
    const pay = await c.post(`/api/visits/${vid}/pay`, { itemIds: items.map((x) => x.id), cash: it2.body.totals?.due ?? it1.body.totals.due, manualNo: i % 3 === 0 ? `م-${i}` : undefined });
    return { c, p, vid, visitNo: v.body.visit.no, items, due: it2.body.totals?.due ?? it1.body.totals.due, pay };
  }));
  const bad = made.filter((m) => m.err || m.pay.status !== 201);
  check('عيادات: كل الزيارات والبنود والدفع نجحت بالتوازي', bad.length === 0, bad.length ? `${bad.length} فشل، مثال: ${bad[0].err || bad[0].pay.status + ' ' + JSON.stringify(bad[0].pay.body).slice(0, 150)}` : '');
  const goods = made.filter((m) => !m.err && m.pay.status === 201);
  check('أرقام الزيارات مش متكررة', uniq(goods.map((m) => m.visitNo)));
  const rcpts = goods.map((m) => m.pay.body.receiptId);
  check('الإيصالات كلها بأرقام فريدة', uniq(rcpts) && rcpts.every(Boolean));
  const rl = (await mgr.get('/api/receipts')).body;
  const rlist = rl.receipts || rl.list || [];
  const rnos = rlist.map((r) => r.no);
  check('أرقام الإيصالات في القايمة مش متكررة', uniq(rnos));

  // 3) دفع بنفس البند مرتين بالتوازي: مرة واحدة بس تنجح
  {
    const p = (await mkPatient(recs[0], 'ازدواج')).body.patient;
    const v = (await recs[0].post('/api/visits', { patientId: p.id, type: 'lab' })).body;
    const d = (await recs[0].post(`/api/visits/${v.visit.id}/items`, { serviceId: labSvc.id })).body;
    const tries = await Promise.all(recs.slice(0, 4).map((c) => c.post(`/api/visits/${v.visit.id}/pay`, { itemIds: d.items.map((x) => x.id), cash: d.totals.due })));
    check('دفع نفس البند من 4 مستخدمين في نفس اللحظة: واحد بس ينجح', tries.filter((t) => t.status === 201).length === 1, tries.map((t) => t.status).join(','));
  }

  // 4) طباعة ثم إلغاء إيصالات: البنود ترجع مستحقة، والإلغاء مرتين ممنوع، والإلغاء المتوازي مرة واحدة
  const victims = goods.slice(0, 10);
  for (const m of victims.slice(0, 3)) await m.c.get('/print/receipt/' + m.pay.body.receiptId);
  const cx = await Promise.all(victims.map((m) => mgr.post(`/api/receipts/${m.pay.body.receiptId}/cancel`, { reason: 'اختبار إلغاء بعد الطباعة' })));
  check('إلغاء إيصالات بعد الطباعة: كلها نجحت', cx.every((r) => r.status === 201), cx.map((r) => r.status).join(','));
  const again = await mgr.post(`/api/receipts/${victims[0].pay.body.receiptId}/cancel`, { reason: 'تاني' });
  check('إلغاء إيصال اتلغى قبل كده: ممنوع', again.status === 409);
  const vd = (await mgr.get(`/api/visits/${victims[0].vid}`)).body;
  check('بعد الإلغاء البنود اتلغت ومفيش مستحق، وفي إيصال إلغاء (مرتجع) مسجّل', vd.totals.due === 0 && (vd.receipts || []).some((r) => r.kind === 'refund'), `due=${vd.totals.due}`);
  {
    const m = goods[10];
    const par = await Promise.all([mgr, mgr, mgr].map((c) => c.post(`/api/receipts/${m.pay.body.receiptId}/cancel`, { reason: 'إلغاء متوازي' })));
    check('إلغاء نفس الإيصال 3 مرات في نفس اللحظة: واحد بس ينجح', par.filter((r) => r.status === 201).length === 1, par.map((r) => r.status).join(','));
  }
  // البنود اللي اتلغى إيصالها مينفعش تتدفع تاني
  const repay = await victims[1].c.post(`/api/visits/${victims[1].vid}/pay`, { itemIds: victims[1].items.map((x) => x.id), cash: victims[1].due });
  check('دفع بنود إيصالها اتلغى: ممنوع', repay.status === 409 || repay.status === 400, String(repay.status));

  // 5) الداخلي: نفس السرير من عدة مستخدمين بالتوازي، وبعدها أسرّة مختلفة
  const board = (await recs[0].get('/api/admissions/beds/board')).body;
  const beds = [];
  for (const f of board.floors) for (const r of f.rooms) for (const b of r.beds) if (b.status === 'free' && r.cls.kind === 'ward' && r.cls.nightPrice) beds.push({ id: b.id, dep: r.cls.deposit || 0 });
  if (beds.length < 2) { check('أسرّة فاضية كفاية للتجربة', false, `الفاضي ${beds.length} — امسح قاعدة التجربة وشغّل تاني`); process.exit(1); }
  const adPat = await Promise.all(recs.map((c, i) => mkPatient(c, 'داخلي' + i, true)));
  const sameBed = await Promise.all(recs.map((c, i) => c.post('/api/admissions', { diagnosis: 'تجربة', patientId: adPat[i].body.patient.id, type: 'inpatient', bedId: beds[0].id, doctorId: doc.id, deposit: beds[0].dep || 1000, cash: beds[0].dep || 1000 })));
  check(`دخول ${WRITERS} مرضى على نفس السرير في نفس اللحظة: واحد بس ينجح`, sameBed.filter((r) => r.status === 201).length === 1, sameBed.map((r) => r.status).join(',') + ' ' + JSON.stringify(sameBed[0].body).slice(0, 200));
  const adPat2 = await Promise.all(recs.slice(0, Math.max(0, Math.min(WRITERS, beds.length - 1))).map((c, i) => mkPatient(c, 'داخلي2' + i, true)));
  const diffBeds = await Promise.all(adPat2.map((p, i) => recs[i].post('/api/admissions', { diagnosis: 'تجربة', patientId: p.body.patient.id, type: 'inpatient', bedId: beds[i + 1].id, doctorId: doc.id, deposit: beds[i + 1].dep || 1000, cash: beds[i + 1].dep || 1000 })));
  check('دخول على أسرّة مختلفة بالتوازي: الكل ينجح', diffBeds.every((r) => r.status === 201), diffBeds.map((r) => r.status).join(','));
  const adNos = [...sameBed, ...diffBeds].filter((r) => r.status === 201).map((r) => r.body.admission.no);
  check('أرقام الدخول مش متكررة', uniq(adNos));
  const admitted = [...sameBed, ...diffBeds].filter((r) => r.status === 201).map((r) => r.body.admission);
  // خدمات على الحساب + إلغاء إيصال التأمين + خروج
  const a0 = admitted[0];
  const addIt = await recs[0].post(`/api/admissions/${a0.id}/items`, { serviceId: labSvc.id });
  check('إضافة خدمة على حساب مريض داخلي', addIt.status === 201 || addIt.status === 200, String(addIt.status));
  const dep = await mgr.get(`/api/admissions/${a0.id}`);
  const depRc = (dep.body.receipts || []).find((r) => r.kind === 'deposit');
  if (depRc) {
    const c1 = await mgr.post(`/api/receipts/${depRc.id}/cancel`, { reason: 'تأمين اتسجل غلط' });
    check('إلغاء إيصال تأمين داخلي بعد الطباعة', c1.status === 201, String(c1.status));
  }
  const prev = await recs[0].get(`/api/admissions/${admitted[1].id}/discharge-preview`);
  const dis = await recs[0].post(`/api/admissions/${admitted[1].id}/discharge`, {});
  check('خروج مريض داخلي بيطلع إذن/إيصال أو بيطلب سداد بشكل مفهوم', [200, 201, 400, 409].includes(dis.status), `${prev.status}/${dis.status} ${JSON.stringify(dis.body).slice(0, 100)}`);

  // 6) الخزينة: وردية مفتوحة، تحصيل أذونات بالتوازي، تحصيل نفس الإذن مرتين، وتقفيل الوردية
  const cas = client(await login('cashier'));
  const op = await cas.post('/api/shifts/open');
  check('فتح وردية خزينة', op.status === 201 || op.status === 409, String(op.status));
  const ord = await Promise.all(patients.slice(30, 40).map(async (p, i) => {
    const c = recs[i % recs.length];
    const v = (await c.post('/api/visits', { patientId: p.id, type: 'lab' })).body;
    const d = (await c.post(`/api/visits/${v.visit.id}/items`, { serviceId: labSvc.id })).body;
    const r = await c.post(`/api/visits/${v.visit.id}/pay`, { itemIds: d.items.map((x) => x.id) });
    return { r, due: d.totals.due, vid: v.visit.id };
  }));
  check('الدفع عند الاستقبال بيطلع أذون للخزينة (وردية مفتوحة)', ord.every((o) => o.r.status === 201 && o.r.body.order), ord.map((o) => o.r.status).join(','));
  const cashiers = await Promise.all([1, 2, 3].map(async () => client(await login('cashier'))));
  const colls = await Promise.all(ord.map((o, i) => cashiers[i % 3].post(`/api/orders/${o.r.body.order.id}/collect`, { cash: o.r.body.order.amount })));
  check('تحصيل 10 أذون بالتوازي من 3 جلسات خزينة', colls.every((r) => r.status === 201), colls.map((r) => r.status).join(','));
  const dbl = await Promise.all([0, 1, 2].map(async () => {
    const p = (await mkPatient(recs[0], 'تحصيل2')).body.patient;
    return p;
  }));
  {
    const p = dbl[0];
    const v = (await recs[0].post('/api/visits', { patientId: p.id, type: 'lab' })).body;
    const d = (await recs[0].post(`/api/visits/${v.visit.id}/items`, { serviceId: labSvc.id })).body;
    const o = (await recs[0].post(`/api/visits/${v.visit.id}/pay`, { itemIds: d.items.map((x) => x.id) })).body.order;
    const tw = await Promise.all(cashiers.map((c) => c.post(`/api/orders/${o.id}/collect`, { cash: o.amount })));
    check('تحصيل نفس الإذن من 3 جلسات في نفس اللحظة: واحد بس ينجح', tw.filter((r) => r.status === 201).length === 1, tw.map((r) => r.status).join(','));
  }
  const mine = (await cas.get('/api/shifts/mine')).body;
  const rep = (await cas.get('/api/reports/treasury')).body;
  const repRows = rep.sections.flatMap((s) => s.rows);
  check('تقرير الخزينة بيشمل الإيصالات', repRows.length > 0, `${repRows.length} صف`);
  const exp = mine.expected ?? mine.shift?.expected ?? mine.expectedCash;
  const hand = (mine.receivers || []).find((u) => u.role === 'cashier');
  const close = await cas.post('/api/shifts/mine/close', { counted: typeof exp === 'number' ? exp : 0, handedTo: hand?.id, diffReason: 'تجربة' });
  check('تقفيل الوردية', [200, 201].includes(close.status), `${close.status} ${JSON.stringify(close.body).slice(0, 120)}`);

  // 7) المخازن: شراء ثم صرف/تحويل بالتوازي، الرصيد ما ينزلش عن صفر ولا يضيع
  const store = client(await login('store'));
  const sacc = client(await login('manager'));
  const meta = (await sacc.get('/api/stores/meta')).body;
  const main = meta.stores.find((s) => /الأدوية الرئيسي/.test(s.name)) || meta.stores[0];
  const dest = meta.stores.find((s) => s.id !== main.id && /الدور|الطوارئ|العيادات/.test(s.name)) || meta.stores[1];
  const stockList = (await sacc.get(`/api/stores/stock?storeId=${main.id}`)).body.items || [];
  const item = [...stockList].sort((a, b) => b.qty - a.qty)[0];
  if (item) {
    const before = item.qty;
    const buy = await sacc.post('/api/stores/purchases', { storeId: main.id, supplier: 'مورد تجربة', lines: [{ itemId: item.id, qty: 50 }] });
    check('شراء بضاعة للمخزن', buy.status === 201 || buy.status === 200, String(buy.status));
    const after = (await sacc.get(`/api/stores/stock?storeId=${main.id}&q=${encodeURIComponent(item.name)}`)).body.items.find((x) => x.id === item.id)?.qty;
    check('الرصيد زاد بالشراء', after === before + 50, `${before} → ${after}`);
    const reqs = await Promise.all([1, 2, 3, 4, 5].map(() => sacc.post('/api/stores/transfers', { fromStoreId: main.id, toStoreId: dest.id, lines: [{ itemId: item.id, qty: Math.ceil(after * 0.4) }] })));
    const okT = reqs.filter((r) => r.status === 201 || r.status === 200);
    check('طلبات تحويل بالتوازي بتتسجل', okT.length > 0, reqs.map((r) => r.status).join(','));
    const sends = [];
    const keepers = await Promise.all(okT.map(async () => client(await login('store'))));
    const sent = await Promise.all(okT.map((r, i) => keepers[i].post(`/api/stores/transfers/${r.body.transfer?.id ?? r.body.id}/issue`, {})));
    sends.push(...sent);
    const left = (await sacc.get(`/api/stores/stock?storeId=${main.id}&q=${encodeURIComponent(item.name)}`)).body.items.find((x) => x.id === item.id)?.qty;
    check('صرف تحويلات بالتوازي من أمين المخزن (من غير صلاحية رصيد سالب): الرصيد مش بينزل عن صفر', left >= 0, `الرصيد ${left}، صرف: ${sends.map((r) => r.status).join(',')}`);
    const issued = sends.filter((r) => r.status === 200 || r.status === 201).length;
    check('الرصيد بعد التحويلات = قبل − اللي اتصرف فعلًا', left === after - issued * Math.ceil(after * 0.4), `${after} − ${issued}×${Math.ceil(after * 0.4)} = ${left}`);
  } else check('المخازن: مفيش أصناف للتجربة', false);

  // 8) الحسابات: ترحيل الورديات لدفتر الأستاذ، وميزان المراجعة متوازن
  const fin = mgr;
  const post = await fin.post('/api/ledger/shifts/post', {});
  check('ترحيل الورديات المقفولة لدفتر الأستاذ', post.status === 200, JSON.stringify(post.body).slice(0, 100));
  const tb = await fin.get('/api/ledger/trial?from=2000-01-01&to=2100-01-01');
  check('ميزان المراجعة متوازن', tb.status === 200 && tb.body.balanced === true, JSON.stringify(tb.body.totals || tb.body.balanced));
  const rm = (await recs[0].get('/api/shifts/mine')).body;
  const rclose = await recs[0].post('/api/shifts/mine/close', { counted: rm.shift?.expected ?? 0, handedTo: (rm.receivers || []).find((u) => u.role === 'cashier')?.id, diffReason: 'تجربة' });
  check('تقفيل وردية الاستقبال (كل المستخدمين على نفس اليوم)', [200, 201].includes(rclose.status), `${rclose.status} ${JSON.stringify(rclose.body).slice(0, 100)}`);
  const ents = (await fin.get('/api/ledger/entries?limit=500')).body;
  check('القيود اتسجلت أوتوماتيك (إيصالات وإلغاءات ووردية)', (ents.entries || ents.rows || []).length > 1, `${(ents.entries || ents.rows || []).length} قيد`);
  const tb2 = await fin.get('/api/ledger/trial?from=2000-01-01&to=2100-01-01');
  check('ميزان المراجعة متوازن بعد ترحيل وردية الاستقبال كمان', tb2.body.balanced === true && tb2.body.totals?.debit > 1320, JSON.stringify(tb2.body.totals));
  const cashAcc = (tb.body.rows || []).find((x) => x.code === '1101');
  check('حساب الخزينة في الدفتر موجود', !!cashAcc, cashAcc ? JSON.stringify(cashAcc).slice(0, 100) : 'مفيش');
  const again2 = await fin.post('/api/ledger/shifts/post', {});
  check('الترحيل مرة تانية مبيكرّرش القيود', again2.body.posted === 0, JSON.stringify(again2.body));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nالنتيجة: ${results.length - failed.length}/${results.length} نجحوا`);
  if (failed.length) console.log('الفاشلين:\n' + failed.map((f) => ' - ' + f.name).join('\n'));
  if (ctx) { ctx.server.close(); await ctx.db.close(); }
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('خطأ في السيناريو:', e); process.exit(2); });
