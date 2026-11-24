// شاشة الإيصال/الفاتورة الإلكترونية: الإعدادات لكل منشأة + قايمة المستندات والرفع
import { router } from '../lib/router.js';
import { need, audit } from '../lib/auth.js';
import { bad, conflict, notFound, intId, str, cents, pounds } from '../lib/util.js';
import { toIso } from '../db/index.js';
import { etaCfg, setEta, ENVS, missing, sweep, refreshIncomplete, submitDoc, submitReady } from '../lib/eta.js';

const dto = (d, withPayload) => ({
  id: d.Id, kind: d.Kind, status: d.Status, env: d.Env, receiptNo: d.ReceiptNo, receiptId: d.ReceiptId, net: pounds(cents(d.Net)), message: d.Message, attempts: d.Attempts,
  createdAt: toIso(d.CreatedAt), submittedAt: toIso(d.SubmittedAt), ...(withPayload ? { payload: d.Payload ? JSON.parse(d.Payload) : null, response: d.Response ? JSON.parse(d.Response) : null, uuid: d.Uuid } : {}),
});

export default function etaRouter(db) {
  const r = router();
  const cfgDto = (c) => ({ ...Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_'))), missing: missing(c), envs: ENVS });

  r.get('/config', async (req, res) => { need(req.user, 'eta.view'); res.json(cfgDto(await etaCfg(db))); });
  r.put('/config', async (req, res) => {
    need(req.user, 'eta.manage');
    const b = req.body || {}, patch = {};
    const T = ['rin', 'tradeName', 'branchCode', 'activityCode', 'posSerial', 'governate', 'regionCity', 'street', 'buildingNumber', 'itemCode'];
    for (const k of T) if (b[k] !== undefined) patch[k] = str(b[k], 100);
    if (b.itemType !== undefined) { if (!['EGS', 'GS1'].includes(b.itemType)) throw bad('نوع الكود EGS أو GS1'); patch.itemType = b.itemType; }
    if (b.unitType !== undefined) patch.unitType = str(b.unitType, 10) || 'EA';
    if (b.vatPct !== undefined) { const v = Number(b.vatPct); if (!(v >= 0 && v <= 100)) throw bad('نسبة الضريبة من 0 لـ 100'); patch.vatPct = String(v); }
    if (b.env !== undefined) { if (!ENVS[b.env]) throw bad('البيئة مش معروفة'); patch.env = b.env; }
    if (b.mode !== undefined) { if (!['auto', 'manual'].includes(b.mode)) throw bad('طريقة الرفع تلقائي أو يدوي'); patch.mode = b.mode; }
    if (b.clientId) patch.clientId = String(b.clientId).trim();
    if (b.clientSecret) patch.clientSecret = String(b.clientSecret).trim();
    const old = await etaCfg(db);
    if (b.enabled !== undefined) {
      patch.enabled = b.enabled ? 'on' : 'off';
      if (b.enabled && !old.enabled && !old.from) patch.from = new Date().toISOString(); // أول تفعيل: بس الإيصالات من دلوقتي
    }
    await db.tx(async (t) => {
      await setEta(t, req.user, patch);
      await audit(t, req.user, 'eta.config', 'Settings', 0, { note: 'تعديل إعدادات الإيصال الإلكتروني', now: { ...patch, clientId: patch.clientId ? '***' : undefined, clientSecret: patch.clientSecret ? '***' : undefined } });
    });
    const c = await etaCfg(db);
    await refreshIncomplete(db, c);
    res.json(cfgDto(c));
  });
  // تفعيل من تاريخ تاني (المدير): الإيصالات من التاريخ ده وطالع هي اللي بتتجهّز
  r.put('/from', async (req, res) => {
    need(req.user, 'eta.manage');
    const d = new Date(String(req.body?.from || ''));
    if (isNaN(d)) throw bad('اختار تاريخ صحيح');
    await setEta(db, req.user, { from: d.toISOString() });
    await audit(db, req.user, 'eta.config', 'Settings', 0, { note: 'تاريخ بداية الإيصالات الإلكترونية', now: { from: d.toISOString() } });
    res.json({ ok: true });
  });

  r.get('/docs', async (req, res) => {
    need(req.user, 'eta.view');
    const st = ['incomplete', 'ready', 'submitted', 'accepted', 'rejected', 'failed', 'skipped'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.query(db.top(`SELECT d.*, r.ReceiptNo, r.Net FROM EtaDocs d JOIN Receipts r ON r.Id = d.ReceiptId ${st ? 'WHERE d.Status = ?' : ''} ORDER BY d.Id DESC`, 200), st ? [st] : []);
    const cnt = await db.query('SELECT Status, COUNT(*) AS N FROM EtaDocs GROUP BY Status');
    res.json({ docs: rows.map((d) => dto(d)), counts: Object.fromEntries(cnt.map((x) => [x.Status, Number(x.N)])) });
  });
  r.get('/docs/:id', async (req, res) => {
    need(req.user, 'eta.view');
    const d = await db.one('SELECT d.*, r.ReceiptNo, r.Net FROM EtaDocs d JOIN Receipts r ON r.Id = d.ReceiptId WHERE d.Id = ?', [intId(req.params.id)]);
    if (!d) throw notFound('المستند مش موجود');
    res.json({ doc: dto(d, true) });
  });
  // تجهيز الإيصالات الجديدة (يدوي)
  r.post('/sweep', async (req, res) => {
    need(req.user, 'eta.submit');
    const c = await etaCfg(db);
    if (!c.enabled) throw conflict('الإيصال الإلكتروني مش مفعّل');
    const n = await sweep(db, c);
    await refreshIncomplete(db, c);
    res.json({ prepared: n });
  });
  // رفع مستند واحد (أو كل الجاهز) — الاتنين بصلاحية الرفع
  r.post('/docs/:id/submit', async (req, res) => {
    need(req.user, 'eta.submit');
    const c = await etaCfg(db);
    const d = await db.one('SELECT * FROM EtaDocs WHERE Id = ?', [intId(req.params.id)]);
    if (!d) throw notFound('المستند مش موجود');
    if (!['ready', 'failed'].includes(d.Status)) throw conflict(d.Status === 'accepted' ? 'المستند ده اتقبل قبل كده' : 'المستند ده مش جاهز للرفع');
    const s = await submitDoc(db, c, d);
    await audit(db, req.user, 'eta.submit', 'EtaDoc', d.Id, { now: { status: s } });
    res.json({ status: s });
  });
  r.post('/submit-all', async (req, res) => {
    need(req.user, 'eta.submit');
    const c = await etaCfg(db);
    if (!c.enabled) throw conflict('الإيصال الإلكتروني مش مفعّل');
    await sweep(db, c);
    const out = await submitReady(db, c);
    await audit(db, req.user, 'eta.submit', 'EtaDoc', 0, { now: out });
    res.json(out);
  });
  return r;
}
