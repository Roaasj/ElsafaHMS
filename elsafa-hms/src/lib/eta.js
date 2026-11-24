// تجهيز الإيصال الإلكتروني (مصلحة الضرايب المصرية): الإعدادات لكل منشأة، بناء المستند، الطابور، والرفع
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './secrets.js';
import { cents, pounds } from './util.js';

const FIELDS = ['enabled', 'mode', 'env', 'rin', 'tradeName', 'branchCode', 'activityCode', 'posSerial', 'governate', 'regionCity', 'street', 'buildingNumber', 'itemType', 'itemCode', 'unitType', 'vatPct', 'from'];
const SECRETS = ['clientId', 'clientSecret'];
export const ENVS = { sim: 'تجربة داخلية (محاكاة، مفيش اتصال)', preprod: 'بيئة اختبار المصلحة (Pre-prod)', prod: 'الحقيقي (Production)' };

export async function etaCfg(db) {
  const rows = await db.query("SELECT [Key] AS K, Value FROM AppSettings WHERE [Key] LIKE 'eta%'");
  const m = Object.fromEntries(rows.map((r) => [r.K, r.Value]));
  const g = (k) => m['eta' + k[0].toUpperCase() + k.slice(1)] ?? '';
  const c = Object.fromEntries(FIELDS.map((f) => [f, g(f)]));
  const dec = (k) => { try { return decrypt(g(k)); } catch { return null; } };
  return {
    ...c, enabled: c.enabled === 'on', mode: ['auto', 'manual'].includes(c.mode) ? c.mode : 'manual', env: ENVS[c.env] ? c.env : 'sim',
    itemType: c.itemType || 'EGS', unitType: c.unitType || 'EA', vatPct: Number(c.vatPct) || 0,
    hasClientId: !!dec('clientId'), hasClientSecret: !!dec('clientSecret'), _clientId: dec('clientId'), _clientSecret: dec('clientSecret'),
  };
}
export async function setEta(db, user, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!FIELDS.includes(k) && !SECRETS.includes(k)) continue;
    const key = 'eta' + k[0].toUpperCase() + k.slice(1);
    const val = SECRETS.includes(k) ? (v ? encrypt(String(v)) : '') : String(v ?? '');
    const ex = await db.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [key]);
    if (ex) await db.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = ?', [val, new Date(), user.id, key]);
    else await db.insert('AppSettings', { '[Key]': key, Value: val, UpdatedAt: new Date(), UpdatedBy: user.id });
  }
}

const iso = (d) => new Date(d).toISOString().replace(/\.\d+Z$/, 'Z');
const r2 = (n) => Math.round(n * 100) / 100;

/** بيانات ناقصة تمنع الرفع */
export function missing(cfg) {
  const m = [];
  if (!cfg.rin) m.push('الرقم الضريبي');
  if (!cfg.tradeName) m.push('الاسم التجاري');
  if (cfg.branchCode === '') m.push('كود الفرع');
  if (!cfg.activityCode) m.push('كود النشاط');
  if (!cfg.posSerial) m.push('الرقم التسلسلي لجهاز نقطة البيع');
  if (!cfg.itemCode) m.push('كود الصنف الافتراضي (EGS/GS1)');
  return m;
}

/** إيصال البيع (النسخة 1.2) من إيصال النظام. بيرجع { payload, skip } */
export async function buildReceiptDoc(db, cfg, rc, uuid) {
  const cash = cents(rc.Cash), card = cents(rc.Card);
  if (['refund', 'return'].includes(rc.Kind) || cents(rc.Net) < 0) return { skip: 'مرتجع: إيصال المرتجع هيتجهّز في مرحلة لاحقة' };
  if (rc.Kind === 'deposit') return { skip: 'تأمين دخول: مش عملية بيع' };
  if (cash + card <= 0) return { skip: 'مفيش مبلغ مدفوع نقدي/فيزا (آجل أو تعاقد)' };
  const items = await db.query('SELECT ServiceName, Qty, UnitPrice, Amount, PatientAmount FROM VisitItems WHERE PaidReceiptId = ? ORDER BY Id', [rc.Id]);
  const vat = cfg.vatPct / 100;
  const lines = items.length ? items.map((i, k) => ({ n: i.ServiceName, q: Number(i.Qty) || 1, tot: cents(i.PatientAmount ?? i.Amount), k })) : [{ n: rc.Note || 'خدمات طبية', q: 1, tot: cents(rc.Gross), k: 0 }];
  const paid = cash + card;
  const gross = lines.reduce((s, l) => s + l.tot, 0) || cents(rc.Gross);
  const ratio = gross > 0 ? paid / gross : 1; // لو فيه آجل جزء من الإيصال بيتحسب بنسبته
  const itemData = lines.map((l) => {
    const net = r2(pounds(Math.round(l.tot * ratio)) / (1 + vat));
    const tax = r2(net * vat);
    return {
      internalCode: String(l.k + 1), description: l.n, itemType: cfg.itemType, itemCode: cfg.itemCode, unitType: cfg.unitType, quantity: l.q,
      unitPrice: r2(net / l.q), netSale: net, totalSale: net, total: r2(net + tax), valueDifference: 0,
      ...(vat > 0 ? { taxableItems: [{ taxType: 'T1', amount: tax, subType: 'V009', rate: cfg.vatPct }] } : {}),
    };
  });
  const netAmount = r2(itemData.reduce((s, i) => s + i.netSale, 0));
  const totalAmount = r2(itemData.reduce((s, i) => s + i.total, 0));
  return {
    payload: {
      header: { dateTimeIssued: iso(rc.CreatedAt), receiptNumber: String(rc.ReceiptNo), uuid, previousUUID: '', referenceOldUUID: '', currency: 'EGP', exchangeRate: 0, orderdeliveryMode: '' },
      documentType: { receiptType: 'S', typeVersion: '1.2' },
      seller: { rin: cfg.rin, companyTradeName: cfg.tradeName, branchCode: cfg.branchCode, branchAddress: { country: 'EG', governate: cfg.governate, regionCity: cfg.regionCity, street: cfg.street, buildingNumber: cfg.buildingNumber }, deviceSerialNumber: cfg.posSerial, activityCode: cfg.activityCode },
      buyer: { type: 'P' },
      itemData, totalSales: netAmount, totalCommercialDiscount: 0, totalItemsDiscount: 0, netAmount, feesAmount: 0, totalAmount,
      taxTotals: vat > 0 ? [{ taxType: 'T1', amount: r2(totalAmount - netAmount) }] : [],
      paymentMethod: cash > 0 ? 'C' : 'V', adjustment: 0,
    },
  };
}

/** إيصالات اتعملت بعد تاريخ التفعيل ومالهاش مستند: بيتعملها مستند (جاهز/ناقص/متخطّى) */
export async function sweep(db, cfg, limit = 200) {
  if (!cfg.enabled || !cfg.from) return 0;
  const rows = await db.query(db.top(`SELECT r.* FROM Receipts r WHERE r.CreatedAt >= ? AND NOT EXISTS (SELECT 1 FROM EtaDocs d WHERE d.ReceiptId = r.Id AND d.Kind = 'receipt') ORDER BY r.Id`, limit), [new Date(cfg.from)]);
  const miss = missing(cfg);
  for (const rc of rows) {
    const uuid = randomUUID();
    const b = await buildReceiptDoc(db, cfg, rc, uuid);
    const base = { Kind: 'receipt', ReceiptId: rc.Id, Uuid: uuid, Env: cfg.env, Attempts: 0, CreatedAt: new Date() };
    if (b.skip) await db.insert('EtaDocs', { ...base, Status: 'skipped', Message: b.skip });
    else await db.insert('EtaDocs', { ...base, Status: miss.length ? 'incomplete' : 'ready', Payload: JSON.stringify(b.payload), Message: miss.length ? 'ناقص: ' + miss.join('، ') : null });
  }
  return rows.length;
}

/** إعادة بناء مستند ناقص بعد ما الإعدادات اتكملت */
export async function refreshIncomplete(db, cfg) {
  if (missing(cfg).length) return 0;
  const docs = await db.query("SELECT d.Id, d.Uuid, r.* , d.Id AS DocId FROM EtaDocs d JOIN Receipts r ON r.Id = d.ReceiptId WHERE d.Status = 'incomplete' AND d.Kind = 'receipt'");
  for (const x of docs) {
    const b = await buildReceiptDoc(db, cfg, x, x.Uuid);
    if (b.payload) await db.run("UPDATE EtaDocs SET Status = 'ready', Payload = ?, Message = NULL, Env = ? WHERE Id = ?", [JSON.stringify(b.payload), cfg.env, x.DocId]);
  }
  return docs.length;
}

/** رفع مستند واحد. المحاكاة بتقفله «اتقبل» محليًا. الاتصال الحقيقي (Pre-prod/Production) هيتفعّل في شريحة لاحقة */
export async function submitDoc(db, cfg, doc) {
  const now = new Date();
  if (cfg.env === 'sim') {
    await db.run("UPDATE EtaDocs SET Status = 'accepted', Env = 'sim', Attempts = Attempts + 1, SubmittedAt = ?, Response = ?, Message = ? WHERE Id = ?", [now, JSON.stringify({ simulated: true, uuid: doc.Uuid }), 'قبول محاكاة داخلية (ما اتبعتش لمصلحة الضرايب)', doc.Id]);
    return 'accepted';
  }
  if (!cfg._clientId || !cfg._clientSecret) {
    await db.run("UPDATE EtaDocs SET Status = 'failed', Attempts = Attempts + 1, Message = ? WHERE Id = ?", ['بيانات الاعتماد (Client ID/Secret) مش متسجّلة في الإعدادات', doc.Id]);
    return 'failed';
  }
  await db.run("UPDATE EtaDocs SET Status = 'failed', Attempts = Attempts + 1, Message = ? WHERE Id = ?", ['الاتصال الحقيقي بالمنظومة لسه ما اتفعّلش في النسخة دي (هيتفعّل بعد اختبار التجهيز)', doc.Id]);
  return 'failed';
}

export async function submitReady(db, cfg, { retryFailed = true, limit = 20 } = {}) {
  const st = retryFailed ? "('ready','failed')" : "('ready')";
  const docs = await db.query(db.top(`SELECT * FROM EtaDocs WHERE Status IN ${st} AND Attempts < 5 AND Payload IS NOT NULL ORDER BY Id`, limit));
  const out = { accepted: 0, failed: 0 };
  for (const d of docs) { const s = await submitDoc(db, cfg, d); out[s] = (out[s] || 0) + 1; }
  return out;
}
