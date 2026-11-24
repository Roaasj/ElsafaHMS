// طباعة الإيصال: A5 (افتراضي) أو حراري 80مم  ->  /print/receipt/:id?fmt=a5|thermal&auto=1
import { R } from '../lib/runtime.js';
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { notFound, intId, cents, pounds, bad } from '../lib/util.js';
import { amountInWords } from '../../shared/tafqeet.js';
import { ageText } from '../../shared/nid.js';
import { toIso, toDateStr } from '../db/index.js';
import { DEPTS } from './catalog.js';
import { ADM_TYPES, admissionDetails } from './admissions.js';
import { treasuryReport, shiftSummary } from './cashier.js';
import { ORDER_KINDS } from '../lib/cashier.js';
import { MODS } from './radiology.js';
import { labGroupDetail, SECTION_EN } from './lab.js';
import { code128Svg } from '../lib/barcode.js';
import { CATS } from '../lib/tickets.js';
import { claimDetails } from './claims.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => R.money.fmtFixedMinor(c);
const when = (d) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: R.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit',
}).format(new Date(d));

export default function printRouter(db, config) {
  const r = router();

  r.get('/receipt/:id', async (req, res) => {
    need(req.user, 'receipts.read');
    const id = intId(req.params.id);
    const rc = await db.one(
      `SELECT r.*, u.FullName AS CreatedByName, v.VisitNo, v.Type AS VisitType, a.AdmissionNo, a.Type AS AdmType,
              COALESCE(v.CardNo, a.CardNo) AS CardNo, py.Name AS PayerName,
              p.FullName, p.PatientNo, p.BirthDate, p.AgeYears, p.AgeRecordedAt, o.ReceiptNo AS OrigNo, m.FullName AS DiscountByName
         FROM Receipts r JOIN Users u ON u.Id = r.CreatedBy LEFT JOIN Visits v ON v.Id = r.VisitId LEFT JOIN Admissions a ON a.Id = r.AdmissionId
         JOIN Patients p ON p.Id = r.PatientId
         LEFT JOIN Payers py ON py.Id = COALESCE(v.PayerId, a.PayerId)
         LEFT JOIN Receipts o ON o.Id = r.ReversesReceiptId
         LEFT JOIN Users m ON m.Id = r.DiscountApprovedBy
        WHERE r.Id = ?`, [id]);
    if (!rc) throw notFound('الإيصال مش موجود');
    const lines = await db.query(
      `SELECT l.*, d.Name AS DoctorName FROM ReceiptLines l JOIN VisitItems i ON i.Id = l.VisitItemId
         LEFT JOIN Doctors d ON d.Id = i.DoctorId WHERE l.ReceiptId = ? ORDER BY l.Id`, [id]);
    const copy = rc.PrintCount > 0;
    await db.run('UPDATE Receipts SET PrintCount = PrintCount + 1 WHERE Id = ?', [id]);
    if (copy) await audit(db, req.user, 'receipt.reprint', 'Receipt', id, { note: 'طباعة نسخة رقم ' + rc.PrintCount });

    const thermal = req.query.fmt === 'thermal';
    const refund = rc.Kind === 'refund' || rc.Kind === 'return';
    const KIND_TITLE = { payment: rc.AdmissionId ? 'دفعة تحت الحساب' : 'إيصال استلام نقدية', deposit: 'إيصال تأمين دخول', final: 'سداد نهائي عند الخروج', return: 'مرتجع للمريض', refund: 'إيصال مرتجع / إلغاء' };
    const where = rc.AdmissionId ? `دخول ${ADM_TYPES[rc.AdmType] || ''} رقم ${rc.AdmissionNo}` : (DEPTS[rc.VisitType] || (rc.VisitType === 'pharmacy' ? 'الصيدلية' : ''));
    const hasPayer = lines.some((l) => cents(l.PayerAmount) !== 0);
    if (!lines.length) lines.push({ Description: rc.Note || KIND_TITLE[rc.Kind], Qty: 1, UnitPrice: rc.Gross, Amount: rc.Gross, DoctorName: null });
    const net = cents(rc.Net), gross = cents(rc.Gross), disc = cents(rc.Discount);
    const pay = [['نقدي', cents(rc.Cash)], ['فيزا', cents(rc.Card)], ['آجل', cents(rc.Credit)]].filter((x) => x[1] !== 0);
    const age = ageText(toDateStr(rc.BirthDate), rc.AgeYears, rc.AgeRecordedAt);

    res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>إيصال ${rc.ReceiptNo}</title>
<link rel="stylesheet" href="/css/fonts.css">
<style>
@page{size:${thermal ? '80mm auto' : 'A5 portrait'};margin:${thermal ? '3mm' : '9mm 10mm'}}
*{box-sizing:border-box}
body{margin:0;font-family:Cairo,Tahoma,sans-serif;color:#1d1412;font-size:${thermal ? '11.5px' : '12.5px'};line-height:1.55;background:#f1ebe5}
.sheet{background:#fff;width:${thermal ? '74mm' : '128mm'};min-height:${thermal ? '0' : '186mm'};margin:16px auto;padding:${thermal ? '2mm' : '0'};position:relative}
@media print{body{background:#fff}.sheet{margin:0;width:auto;min-height:0}.noprint{display:none!important}}
.head{display:flex;align-items:center;gap:10px;border-bottom:2px solid ${R.brand.primary};padding-bottom:8px;${thermal ? 'flex-direction:column;text-align:center;gap:4px' : ''}}
.head img{width:${thermal ? '40px' : '54px'};height:${thermal ? '40px' : '54px'}}
.head h1{margin:0;font-size:${thermal ? '14px' : '17px'};font-weight:800;color:${R.brand.primary}}
.head p{margin:0;color:#6b5a54;font-size:11px}
.kind{margin-inline-start:auto;text-align:center;${thermal ? 'margin:0' : ''}}
.kind b{display:block;font-size:${thermal ? '13px' : '15px'};font-weight:800}
.kind span{font-size:12px;color:#6b5a54}
.kind .no{display:inline-block;margin-top:2px;padding:1px 10px;border:1.5px solid #1d1412;border-radius:6px;font-weight:800;font-size:14px;color:#1d1412}
.meta{display:grid;grid-template-columns:${thermal ? '1fr' : '1fr 1fr'};gap:2px 14px;margin:8px 0;padding:6px 8px;background:#faf4ef;border-radius:6px}
.meta div{display:flex;gap:6px}.meta i{font-style:normal;color:#6b5a54;min-width:62px}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{background:${R.brand.primary};color:#fff;font-weight:700;padding:4px 6px;text-align:start;font-size:11.5px}
td{padding:4px 6px;border-bottom:1px solid #eadfd6;vertical-align:top}
td.n,th.n{text-align:left;white-space:nowrap;font-variant-numeric:tabular-nums}
td small{display:block;color:#6b5a54;font-size:10.5px}
.tot{margin-top:8px;margin-inline-start:auto;width:${thermal ? '100%' : '62%'}}
.tot div{display:flex;justify-content:space-between;padding:2px 6px}
.tot .grand{background:#1d1412;color:#fff;border-radius:6px;font-weight:800;font-size:14px;padding:5px 8px;margin-top:3px}
.payer{margin:4px 0 0;padding:3px 8px;border-radius:6px;background:#eef3fb;color:#2b4f86;font-size:11.5px}
.words{margin-top:8px;padding:5px 8px;border:1px dashed #c9b7aa;border-radius:6px;font-weight:700;font-size:11.5px}
.note{margin-top:6px;font-size:11px;color:#6b5a54}
.foot{display:flex;justify-content:space-between;margin-top:18px;font-size:11px;color:#6b5a54;${thermal ? 'flex-direction:column;gap:4px;margin-top:10px' : ''}}
.sign{border-top:1px solid #b9a79b;padding-top:2px;min-width:110px;text-align:center}
.stamp{position:absolute;top:42%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);font-size:${thermal ? '30px' : '54px'};font-weight:800;color:rgba(154,0,0,.12);border:5px solid rgba(154,0,0,.12);padding:0 18px;border-radius:12px;pointer-events:none;white-space:nowrap}
.bar{position:fixed;inset:auto 0 0 0;display:flex;gap:8px;justify-content:center;padding:10px;background:rgba(255,255,255,.92);border-top:1px solid #eadfd6}
.bar button,.bar a{font:inherit;font-weight:700;padding:8px 18px;border-radius:10px;border:0;background:${R.brand.primary};color:#fff;cursor:pointer;text-decoration:none}
.bar a{background:#f3e9e1;color:#1d1412}
</style></head><body>
<div class="sheet">
  ${copy ? '<div class="stamp">نسخة</div>' : ''}${refund ? '<div class="stamp" style="top:60%">مرتجع</div>' : ''}
  <div class="head">
    <img src="/brand/logo" alt="">
    <div><h1>${esc(R.brand.name)}</h1><p>${KIND_TITLE[rc.Kind]} · ${esc(where)}</p></div>
    <div class="kind"><b>${rc.Kind === 'return' ? 'مرتجع' : refund ? 'مرتجع' : rc.Kind === 'deposit' ? 'تأمين' : 'إيصال'}</b><span class="no">${rc.ReceiptNo}</span></div>
  </div>
  <div class="meta">
    <div><i>المريض</i><b>${esc(rc.FullName)}</b></div>
    <div><i>رقم الملف</i><b>${rc.PatientNo}</b></div>
    <div><i>التاريخ</i><span>${when(toIso(rc.CreatedAt))}</span></div>
    <div><i>${rc.AdmissionId ? 'رقم الدخول' : 'رقم الزيارة'}</i><span>${rc.AdmissionId ? rc.AdmissionNo : rc.VisitNo}${age ? ' · السن ' + esc(age) : ''}</span></div>
    ${rc.ManualNo ? `<div><i>إيصال يدوي</i><b>${esc(rc.ManualNo)}</b></div>` : ''}
    ${rc.Kind === 'refund' ? `<div><i>عن إيصال</i><b>${rc.OrigNo}</b></div><div><i>السبب</i><span>${esc(rc.Reason)}</span></div>` : ''}
  </div>
  ${rc.PayerName ? `<div class="payer">التعاقد: <b>${esc(rc.PayerName)}</b>${rc.CardNo ? ` · كارنيه ${esc(rc.CardNo)}` : ''}</div>` : ''}
  <table><thead><tr><th>البيان</th><th class="n">العدد</th>${hasPayer ? '<th class="n">القيمة</th><th class="n">نصيب التعاقد</th><th class="n">على المريض</th>' : '<th class="n">السعر</th><th class="n">القيمة</th>'}</tr></thead><tbody>
  ${lines.map((l) => `<tr><td>${esc(l.Description)}${l.DoctorName ? `<small>د. ${esc(l.DoctorName.replace(/^د\.?\s*/, ''))}</small>` : ''}</td>
    <td class="n">${l.Qty}</td>${hasPayer ? `<td class="n">${money(cents(l.Amount) + cents(l.PayerAmount))}</td><td class="n">${money(cents(l.PayerAmount))}</td><td class="n">${money(cents(l.Amount))}</td>`
    : `<td class="n">${money(cents(l.UnitPrice))}</td><td class="n">${money(cents(l.Amount))}</td>`}</tr>`).join('')}
  </tbody></table>
  <div class="tot">
    ${hasPayer ? `<div><span>القيمة الكلية</span><span>${money(lines.reduce((s, l) => s + cents(l.Amount) + cents(l.PayerAmount), 0))}</span></div><div><span>نصيب التعاقد</span><span>${money(lines.reduce((s, l) => s + cents(l.PayerAmount), 0))}</span></div>` : ''}
    <div><span>${hasPayer ? 'على المريض' : 'الإجمالي'}</span><b>${money(gross)}</b></div>
    ${disc ? `<div><span>خصم</span><b>${money(disc)}</b></div>` : ''}
    ${pay.length > 1 || (pay[0] && pay[0][0] !== 'نقدي') ? pay.map((x) => `<div><span>${x[0]}</span><span>${money(x[1])}</span></div>`).join('') : ''}
    <div class="grand"><span>${refund ? 'المردود للمريض' : 'المدفوع'}</span><span>${money(Math.abs(net))} ${R.money.symbol}</span></div>
  </div>
  <div class="words">${esc(amountInWords(Math.abs(net)))}</div>
  ${disc && rc.DiscountReason ? `<div class="note">سبب الخصم: ${esc(rc.DiscountReason)}${rc.DiscountByName ? ' · بموافقة ' + esc(rc.DiscountByName) : ''}</div>` : ''}
  <div class="foot"><span>الموظف: ${esc(rc.CreatedByName)}</span><span class="sign">توقيع المستلم</span></div>
</div>
<div class="bar noprint"><button onclick="print()">اطبع</button><a href="?fmt=${thermal ? 'a5' : 'thermal'}">${thermal ? 'شكل A5' : 'شكل الطابعة الحرارية'}</a><a href="javascript:close()">اقفل</a></div>
${req.query.auto === '1' ? '<script>addEventListener("load",()=>setTimeout(()=>print(),250))</script>' : ''}
</body></html>`);
  });

  // كشف حساب الإقامة / الفاتورة النهائية:  ?mode=detail تفصيلية (A4) | summary إجمالية (A5)
  r.get('/admission/:id', async (req, res) => {
    need(req.user, 'admissions.read');
    const d = await admissionDetails(db, intId(req.params.id));
    const a = d.admission, p = d.patient, t = d.totals;
    const final = a.status === 'discharged';
    const closed = a.bill?.status === 'closed';
    const summary = req.query.mode === 'summary';
    const c = (v) => money(R.money.toMinor(v));
    const day = (s) => (s ? `${Number(s.slice(8, 10))}/${Number(s.slice(5, 7))}` : '');
    const addDay = (x) => (x ? day(x) : '');
    // الليالي متجمعة حسب الدرجة والسعر
    const groups = [];
    for (const i of d.items.filter((x) => x.kind === 'night' && x.status === 'active')) {
      const k = i.name + '|' + i.unitPrice;
      let g = groups.find((x) => x.k === k);
      if (!g) groups.push(g = { k, name: i.name, price: i.unitPrice, n: 0, from: i.date, to: i.date, note: i.note });
      g.n++; g.to = i.date;
    }
    const live = d.items.filter((x) => x.kind !== 'night' && x.status === 'active');
    const cats = Object.keys(CATS).filter((k) => k !== 'night');
    const title = final ? 'فاتورة نهائية' : closed ? 'فاتورة (التذكرة مقفولة)' : 'كشف حساب إقامة (مبدئي)';
    const sections = summary
      ? `<h4>الحساب الإجمالي</h4><table><thead><tr><th>البند</th><th class="n">عدد</th><th class="n">القيمة</th>${a.payer ? '<th class="n">على التعاقد</th><th class="n">على المريض</th>' : ''}</tr></thead><tbody>
${Object.keys(CATS).map((k) => {
    const xs = d.items.filter((i) => i.status === 'active' && i.cat === k);
    if (!xs.length) return '';
    const sum = (f) => xs.reduce((s2, i) => s2 + R.money.toMinor(f(i)), 0) / R.money.F;
    return `<tr><td><b>${CATS[k]}</b>${k === 'night' ? ` <small>(${a.nights} ليلة)</small>` : ''}</td><td class="n">${k === 'night' ? xs.length : xs.reduce((s2, i) => s2 + i.qty, 0)}</td><td class="n">${c(sum((i) => i.amount))}</td>${a.payer ? `<td class="n">${c(sum((i) => i.payerAmount))}</td><td class="n">${c(sum((i) => i.patientAmount))}</td>` : ''}</tr>`;
  }).join('')}</tbody></table>`
      : `<h4>الإقامة (${a.nights} ليلة)</h4>
<table><thead><tr><th>البيان</th><th>من</th><th>لـ</th><th class="n">ليالي</th><th class="n">السعر</th><th class="n">القيمة</th></tr></thead><tbody>
${groups.map((g) => `<tr><td>${esc(g.name)}${g.note ? ` <small>(${esc(g.note)})</small>` : ''}</td><td>${day(g.from)}</td><td>${day(g.to)}</td><td class="n">${g.n}</td><td class="n">${c(g.price)}</td><td class="n">${c(g.price * g.n)}</td></tr>`).join('')}
</tbody></table>
${cats.map((k) => {
    const xs = live.filter((i) => i.cat === k);
    if (!xs.length) return '';
    const tot = xs.reduce((s2, i) => s2 + R.money.toMinor(i.amount), 0) / R.money.F;
    return `<h4>${CATS[k]}</h4><table class="it"><thead><tr><th style="width:46px">اليوم</th><th>البيان</th><th class="n" style="width:52px">العدد</th><th class="n" style="width:84px">السعر</th><th class="n" style="width:92px">القيمة</th></tr></thead><tbody>
${xs.map((i) => `<tr><td>${addDay(i.date) || '<small>—</small>'}</td><td>${esc(i.name)}${i.doctorName ? ` <small>· ${esc(i.doctorName)}</small>` : ''}${i.note && !i.fromVisit ? ` <small>(${esc(i.note)})</small>` : ''}</td><td class="n">${i.qty}</td><td class="n">${c(i.unitPrice)}</td><td class="n">${c(i.amount)}</td></tr>`).join('')}
<tr class="st"><td></td><td>إجمالي ${CATS[k]}</td><td></td><td></td><td class="n">${c(tot)}</td></tr></tbody></table>`;
  }).join('')}`;
    const pays = d.receipts;
    const catTot = Object.keys(CATS).filter((k) => t.byCat?.[k]).map((k) => `<div><span>${CATS[k]}</span><b>${c(t.byCat[k])}</b></div>`).join('');
    res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${final ? 'فاتورة' : 'كشف حساب'} دخول ${a.no}</title>
<link rel="stylesheet" href="/css/fonts.css"><style>
@page{size:${summary ? 'A5' : 'A4'} portrait;margin:8mm 9mm}*{box-sizing:border-box}
body{margin:0;font-family:Cairo,Tahoma,sans-serif;color:#1d1412;font-size:11.5px;line-height:1.5;background:#f1ebe5}
.sheet{background:#fff;width:${summary ? '130mm' : '190mm'};margin:16px auto;padding:0}@media print{body{background:#fff}.sheet{margin:0;width:auto}.noprint{display:none!important}}
.head{display:flex;align-items:center;gap:10px;border-bottom:2px solid ${R.brand.primary};padding-bottom:6px}.head img{width:48px;height:48px}
.head h1{margin:0;font-size:16px;color:${R.brand.primary}}.head p{margin:0;color:#6b5a54;font-size:11px}.head .k{margin-inline-start:auto;text-align:center;font-weight:800;font-size:14px}
.head .k span{display:inline-block;border:1.5px solid #1d1412;border-radius:6px;padding:0 9px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:1px 12px;margin:7px 0;padding:5px 8px;background:#faf4ef;border-radius:6px}.meta i{font-style:normal;color:#6b5a54;margin-inline-end:6px}
h4{margin:9px 0 3px;font-size:12px;color:${R.brand.primary}}table{width:100%;border-collapse:collapse;page-break-inside:auto}tr{page-break-inside:avoid}th{background:#f3e9e1;font-weight:700;padding:3px 6px;text-align:start;font-size:11px}
td{padding:3px 6px;border-bottom:1px solid #eee3da}table.it{table-layout:fixed}td.n,th.n{text-align:left;white-space:nowrap}td small{color:#6b5a54}tr.st td{font-weight:800;background:#faf4ef;border-bottom:0}
.tot{margin-top:8px;margin-inline-start:auto;width:${summary ? '64%' : '46%'};page-break-inside:avoid}.tot div{display:flex;justify-content:space-between;padding:2px 6px}.tot .sep{border-top:1px dashed #d9c9bd;margin-top:3px;padding-top:4px}
.tot .g{background:#1d1412;color:#fff;border-radius:6px;font-weight:800;font-size:13px;padding:4px 8px;margin-top:3px}
.foot{display:flex;justify-content:space-between;gap:16px;margin-top:16px;font-size:11px;color:#6b5a54}.sign{border-top:1px solid #b9a79b;min-width:100px;text-align:center}
.bar{position:fixed;inset:auto 0 0 0;display:flex;gap:8px;justify-content:center;padding:10px;background:rgba(255,255,255,.92);border-top:1px solid #eadfd6}
.bar button,.bar a{font:inherit;font-weight:700;padding:8px 18px;border-radius:10px;border:0;background:${R.brand.primary};color:#fff;cursor:pointer;text-decoration:none}.bar a{background:#f3e9e1;color:#1d1412}
</style></head><body><div class="sheet">
<div class="head"><img src="/brand/logo" alt=""><div><h1>${esc(R.brand.name)}</h1><p>${title} · ${summary ? 'إجمالية' : 'تفصيلية'} · ${esc(a.typeName)}</p></div><div class="k">دخول<br><span>${a.no}</span></div></div>
<div class="meta">
  <div><i>المريض</i><b>${esc(p.name)}</b></div><div><i>رقم الملف</i><b>${p.no}</b></div>
  <div><i>الدخول</i>${when(a.admittedAt)}</div><div><i>${final ? 'الخروج' : closed ? 'اتقفلت' : 'لحد'}</i>${when(a.dischargedAt || a.bill?.closedAt || new Date())}</div>
  <div><i>الطبيب</i>${esc(a.doctorName || '—')}</div>${a.payer ? `<div><i>التعاقد</i>${esc(a.payer.name)} · ${esc(a.payer.tierName)}${a.payer.cardNo ? ' · ' + esc(a.payer.cardNo) : ''}${a.payer.status === 'rejected' ? ' (اترفض)' : ''}</div><div></div>` : ''}<div><i>الغرفة</i>${esc(d.bed.room.no)} / ${esc(d.bed.label)} · ${esc(d.bed.cls.name)}</div>
</div>
${sections}
${pays.length ? `<h4>المدفوعات</h4><table><tbody>${pays.map((r2) => `<tr><td>${esc(r2.kindName)} رقم ${r2.no}${r2.manualNo ? ` <small>(يدوي ${esc(r2.manualNo)})</small>` : ''}${r2.reversed ? ' <small>(اتلغى)</small>' : ''}</td><td>${when(r2.createdAt)}</td><td class="n">${c(r2.net)}</td></tr>`).join('')}</tbody></table>` : ''}
<div class="tot">
  ${summary ? '' : catTot}
  <div class="${summary ? '' : 'sep'}"><span>الإجمالي</span><b>${c(t.total)}</b></div>${a.payer ? `<div><span>نصيب التعاقد (${esc(a.payer.name)})</span><b>${c(t.payer)}</b></div><div><span>على المريض</span><b>${c(t.patient)}</b></div>` : ''}${t.discount ? `<div><span>خصم</span><b>${c(t.discount)}</b></div>` : ''}
  <div><span>المدفوع</span><b>${c(t.paid)}</b></div>${t.credit ? `<div><span>منه آجل</span><b>${c(t.credit)}</b></div>` : ''}
  <div class="g"><span>${final ? 'الباقي' : t.balance >= 0 ? (closed ? 'المطلوب عند الخروج' : 'المطلوب لحد دلوقتي') : 'رصيد للمريض'}</span><span>${c(Math.abs(t.balance))} ${R.money.symbol}</span></div>
</div>
<div class="foot"><span>اتطبع: ${esc(req.user.name)} · ${when(new Date())}${a.bill?.closedBy ? ` · قفل التذكرة: ${esc(a.bill.closedBy)}` : ''}</span><span class="sign">الحسابات</span><span class="sign">توقيع المريض / المرافق</span></div>
</div><div class="bar noprint"><button onclick="print()">اطبع</button><a href="?mode=${summary ? 'detail' : 'summary'}">${summary ? 'التفصيلية' : 'الإجمالية'}</a><a href="javascript:close()">اقفل</a></div>
${req.query.auto === '1' ? '<script>addEventListener("load",()=>setTimeout(()=>print(),250))</script>' : ''}</body></html>`);
  });

  // ورقة الجرد: الأصناف والتشغيلات وخانة فاضية للعد (من غير رصيد البرنامج إلا لو ?system=1)
  r.get('/count/:id', async (req, res) => {
    need(req.user, 'stock.view');
    const id = intId(req.params.id);
    const c = await db.one('SELECT c.*, s.Name AS StoreName FROM StockCounts c JOIN Stores s ON s.Id = c.StoreId WHERE c.Id = ?', [id]);
    if (!c) throw notFound('الجرد مش موجود');
    const lines = await db.query(`SELECT l.*, i.Name, i.Code, i.Unit FROM StockCountLines l JOIN StockItems i ON i.Id = l.ItemId WHERE l.CountId = ? ORDER BY i.Kind, i.Name, l.Expiry`, [id]);
    const sys = req.query.system === '1';
    const d = (x) => (x ? toDateStr(x).split('-').reverse().join('/') : '—');
    res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>جرد ${c.CountNo}</title><link rel="stylesheet" href="/css/fonts.css">
<style>@page{size:A4 portrait;margin:9mm}*{box-sizing:border-box}body{margin:0;font-family:Cairo,Tahoma,sans-serif;font-size:11.5px;color:#1d1412;background:#f1ebe5}
.sheet{background:#fff;width:192mm;margin:16px auto}@media print{body{background:#fff}.sheet{margin:0;width:auto}.noprint{display:none}}
.head{display:flex;align-items:center;gap:10px;border-bottom:2px solid ${R.brand.primary};padding-bottom:6px;margin-bottom:8px}.head img{width:44px}.head h1{margin:0;font-size:16px;color:${R.brand.primary}}.head p{margin:0;color:#6b5a54}
.head .k{margin-inline-start:auto;text-align:center;font-weight:800}table{width:100%;border-collapse:collapse}th{background:#f3e9e1;padding:4px 6px;text-align:start}td{padding:5px 6px;border-bottom:1px solid #e8ddd3}
td.box{border:1px solid #b9a79b;width:90px}tr{page-break-inside:avoid}.foot{display:flex;justify-content:space-between;margin-top:26px}.sign{border-top:1px solid #b9a79b;min-width:150px;text-align:center;padding-top:3px}
.bar{position:fixed;inset:auto 0 0 0;display:flex;gap:8px;justify-content:center;padding:10px;background:rgba(255,255,255,.92)}.bar button,.bar a{font:inherit;font-weight:700;padding:8px 18px;border-radius:10px;border:0;background:${R.brand.primary};color:#fff;text-decoration:none}.bar a{background:#f3e9e1;color:#1d1412}</style></head>
<body><div class="sheet"><div class="head"><img src="/brand/logo" alt=""><div><h1>${esc(R.brand.name)}</h1><p>ورقة جرد · ${esc(c.StoreName)} · ${when(c.CreatedAt)}</p></div><div class="k">جرد<br>${c.CountNo}</div></div>
<table><thead><tr><th>#</th><th>الكود</th><th>الصنف</th><th>الوحدة</th><th>التشغيلة</th><th>الصلاحية</th>${sys ? '<th>رصيد البرنامج</th>' : ''}<th>العدد الفعلي</th></tr></thead><tbody>
${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.Code)}</td><td>${esc(l.Name)}</td><td>${esc(l.Unit || '')}</td><td>${esc(l.BatchNo || '—')}</td><td>${d(l.Expiry)}</td>${sys ? `<td>${Number(l.SystemQty)}</td>` : ''}<td class="box">${l.CountedQty == null || !sys ? '' : Number(l.CountedQty)}</td></tr>`).join('')}
</tbody></table><p style="color:#6b5a54">أصناف لقيتها ومش في الورقة: اكتبها تحت بالاسم والتشغيلة والصلاحية والعدد.</p>
<div class="foot"><span class="sign">القائم بالجرد</span><span class="sign">أمين المخزن</span><span class="sign">المراجعة</span></div></div>
<div class="bar noprint"><button onclick="print()">اطبع</button><a href="?system=${sys ? '0' : '1'}">${sys ? 'من غير رصيد البرنامج' : 'برصيد البرنامج'}</a></div>
${req.query.auto === '1' ? '<script>addEventListener("load",()=>setTimeout(()=>print(),250))</script>' : ''}</body></html>`);
  });

  // كشف صرف مستحقات الأطباء لشهر (الصافي بعد الضريبة وخانة التوقيع)
  r.get('/payouts', async (req, res) => {
    need(req.user, 'fin.view');
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.period || '') ? req.query.period : null;
    if (!period) throw bad('اختار الشهر');
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
    const rows = await db.query(
      `SELECT p.*, d.Name AS DoctorName, d.Specialty FROM DoctorPayouts p JOIN Doctors d ON d.Id = p.DoctorId WHERE p.Period = ? AND p.Status <> 'void' ${ids.length ? `AND p.Id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY d.Name`,
      ids.length ? [period, ...ids] : [period]);
    const sum = (k) => rows.reduce((a, x) => a + cents(x[k]), 0);
    const m = (n) => R.money.fixed(n);
    const [y, mo] = period.split('-').map(Number);
    const mName = `${['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'][mo - 1]} ${y}`;
    res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كشف صرف ${esc(mName)}</title><link rel="stylesheet" href="/css/fonts.css">
<style>@page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}body{margin:0;font-family:Cairo,Tahoma,sans-serif;font-size:12px;color:#1d1412;background:#f1ebe5}
.sheet{background:#fff;width:190mm;margin:16px auto;padding:2px}@media print{body{background:#fff}.sheet{margin:0;width:auto}.noprint{display:none}}
.head{display:flex;align-items:center;gap:10px;border-bottom:2px solid ${R.brand.primary};padding-bottom:6px;margin-bottom:10px}.head img{width:46px}.head h1{margin:0;font-size:17px;color:${R.brand.primary}}.head p{margin:0;color:#6b5a54}
.head .k{margin-inline-start:auto;text-align:center;font-weight:800}table{width:100%;border-collapse:collapse}th{background:#f3e9e1;padding:6px;text-align:start}td{padding:9px 6px;border-bottom:1px solid #e8ddd3}
td.n,th.n{text-align:end;font-variant-numeric:tabular-nums}td.sg{width:34mm;border:1px solid #cdbcaf}tfoot td{font-weight:800;border-top:2px solid ${R.brand.primary};background:#fbf6f1}tr{page-break-inside:avoid}
.foot{display:flex;justify-content:space-between;margin-top:34px}.sign{border-top:1px solid #b9a79b;min-width:150px;text-align:center;padding-top:3px}
.bar{position:fixed;inset:auto 0 0 0;display:flex;gap:8px;justify-content:center;padding:10px;background:rgba(255,255,255,.92)}.bar button{font:inherit;font-weight:700;padding:8px 18px;border-radius:10px;border:0;background:${R.brand.primary};color:#fff}</style></head>
<body><div class="sheet"><div class="head"><img src="/brand/logo" alt=""><div><h1>${esc(R.brand.name)}</h1><p>كشف صرف مستحقات الأطباء · ${esc(mName)}</p></div><div class="k">${rows.length} دكتور</div></div>
<table><thead><tr><th>#</th><th>الدكتور</th><th class="n">المستحق</th><th class="n">الضريبة</th><th class="n">الصافي</th><th>التوقيع بالاستلام</th></tr></thead><tbody>
${rows.map((x, i) => `<tr><td>${i + 1}</td><td><b>${esc(x.DoctorName)}</b>${x.Specialty ? `<br><small style="color:#6b5a54">${esc(x.Specialty)}</small>` : ''}</td><td class="n">${m(x.Gross)}</td><td class="n">${m(x.Tax)} <small>(${Number(x.TaxPct)}%)</small></td><td class="n"><b>${m(x.Net)}</b></td><td class="sg"></td></tr>`).join('')}
</tbody><tfoot><tr><td></td><td>الإجمالي</td><td class="n">${m(pounds(sum('Gross')))}</td><td class="n">${m(pounds(sum('Tax')))}</td><td class="n">${m(pounds(sum('Net')))}</td><td></td></tr></tfoot></table>
<p style="margin-top:10px">الإجمالي بالحروف (الصافي): <b>${esc(amountInWords(sum('Net')))}</b></p>
<div class="foot"><span class="sign">أعدّه</span><span class="sign">أمين الخزينة</span><span class="sign">المدير</span></div></div>
<div class="bar noprint"><button onclick="print()">اطبع</button></div>
${req.query.auto === '1' ? '<script>addEventListener("load",()=>setTimeout(()=>print(),250))</script>' : ''}</body></html>`);
  });

  // ===== صفحة طباعة عامة =====
  const page = ({ title, size, body, auto, extraCss = '' }) => `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="stylesheet" href="/css/fonts.css">
<style>
@page{size:${size};margin:8mm}
*{box-sizing:border-box}
body{margin:0;font-family:Cairo,Tahoma,sans-serif;color:#1d1412;font-size:12px;line-height:1.5;background:#f1ebe5}
.sheet{background:#fff;margin:16px auto;padding:10mm;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.head{display:flex;align-items:center;gap:10px;border-bottom:2px solid ${R.brand.primary};padding-bottom:8px;margin-bottom:10px}
.head img{width:48px;height:48px}.head h1{margin:0;font-size:16px;font-weight:800;color:${R.brand.primary}}.head p{margin:0;color:#6b5a54;font-size:11px}
.head .kind{margin-inline-start:auto;text-align:center}.head .kind b{display:block;font-size:15px;font-weight:800}
table{width:100%;border-collapse:collapse}
th{background:${R.brand.primary};color:#fff;font-weight:700;padding:4px 5px;text-align:start;font-size:11px}
td{padding:3px 5px;border-bottom:1px solid #eadfd6;vertical-align:top;font-size:11.2px}
td.n,th.n{text-align:left;white-space:nowrap;font-variant-numeric:tabular-nums}
.sec{margin-top:10px;break-inside:auto}.sec h3{margin:0 0 3px;font-size:13px;font-weight:800;display:flex;gap:8px;align-items:center}
.sec h3 span{font-weight:600;color:#6b5a54;font-size:11px}
tr.sub td{background:#f6eee8;font-weight:800;border-bottom:2px solid #d9c6b8}
tr.out td{color:#a12a2a}
.grand{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:12px}
.grand div{border:1px solid #eadfd6;border-radius:6px;padding:5px 8px}.grand small{display:block;color:#6b5a54;font-size:10.5px}.grand b{font-size:14px}
.grand .net{background:#1d1412;color:#fff;border-color:#1d1412}.grand .net small{color:#d9c6b8}
.foot{display:flex;justify-content:space-around;margin-top:28px;font-size:11px;color:#6b5a54}.sign{border-top:1px solid #b9a79b;padding-top:2px;min-width:140px;text-align:center}
.kv{display:grid;grid-template-columns:1fr 1fr;gap:3px 16px;margin:8px 0;padding:6px 8px;background:#faf4ef;border-radius:6px}.kv div{display:flex;justify-content:space-between;gap:6px}.kv i{font-style:normal;color:#6b5a54}
.bar{position:fixed;inset:auto 0 0 0;display:flex;gap:8px;justify-content:center;padding:10px;background:rgba(255,255,255,.92);border-top:1px solid #eadfd6}
.bar button,.bar a{font:inherit;font-weight:700;padding:8px 18px;border-radius:10px;border:0;background:${R.brand.primary};color:#fff;cursor:pointer;text-decoration:none}.bar a{background:#f3e9e1;color:#1d1412}
@media print{body{background:#fff}.sheet{margin:0;box-shadow:none;padding:0}.noprint{display:none}}
${extraCss}
</style></head><body>${body}
<div class="bar noprint"><button onclick="print()">اطبع</button><a href="javascript:close()">اقفل</a></div>
${auto ? '<script>addEventListener("load",()=>setTimeout(()=>print(),250))</script>' : ''}</body></html>`;
  const head = (title, sub, kind) => `<div class="head"><img src="/brand/logo" alt=""><div><h1>${esc(R.brand.name)}</h1><p>${esc(sub)}</p></div><div class="kind"><b>${esc(title)}</b>${kind || ''}</div></div>`;
  const dayName = (d) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d + 'T00:00:00Z'));
  const time = (d) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: R.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
  const m = (v) => money(R.money.toMinor(v));

  // المطالبة الشهرية: ورقة Cover ملخصة، وبعدها التفصيلي (كل حالة ببنودها بتاريخ الخدمة)
  r.get('/claim/:id', async (req, res) => {
    if (!['claims.review', 'claims.manage'].some((p) => can(req.user, p))) need(req.user, 'claims.manage');
    const d = await claimDetails(db, intId(req.params.id));
    const c = d.claim, T = d.totals;
    const dd = (x) => (x ? x.split('-').reverse().join('/') : '—');
    const draft = c.status === 'draft' ? '<div style="position:fixed;top:40%;inset-inline:0;text-align:center;font-size:90px;font-weight:800;color:rgba(154,0,0,.07);transform:rotate(-18deg);pointer-events:none">مسودة</div>' : '';
    const cover = `<div class="sheet" style="width:194mm;min-height:270mm;display:flex;flex-direction:column">
  ${head('مطالبة' + (c.supplement ? ' تكميلية' : ''), 'إدارة حسابات التعاقدات', `<span style="font-size:20px;font-weight:800">${c.no}</span>`)}
  <div class="kv" style="font-size:13px"><div><i>إلى</i><b>${esc(c.payer.name)}</b></div><div><i>تاريخ الإصدار</i><b>${dd(c.issueDate) === '—' ? 'لسه ما اتبعتتش' : dd(c.issueDate)}</b></div>
    <div><i>عن شهر</i><b>${esc(c.periodName)}</b></div><div><i>عدد الحالات</i><b>${T.visits + T.admissions}</b></div></div>
  <p style="font-size:13px;margin:14px 0 8px">السادة / ${esc(c.payer.name)}${c.payer.contact ? ` — عناية ${esc(c.payer.contact)}` : ''}<br>تحية طيبة وبعد،<br>
  مرفق لسيادتكم مطالبة المستشفى عن الخدمات المقدمة للمنتفعين خلال شهر ${esc(c.periodName)}${c.supplement ? ' (فروق وحالات لم ترد في المطالبة السابقة)' : ''}، وبيانها كالتالي:</p>
  <table style="font-size:13px"><thead><tr><th>البيان</th><th class="n">عدد الحالات</th><th class="n">المبلغ</th></tr></thead><tbody>
    <tr><td>الخارجي (العيادات والطوارئ والمعمل والأشعة)</td><td class="n">${T.visits}</td><td class="n">${m(T.visitsAmount)}</td></tr>
    <tr><td>الداخلي (الإقامة والعمليات والعناية والحضانة)</td><td class="n">${T.admissions}</td><td class="n">${m(T.admissionsAmount)}</td></tr>
    <tr class="sub"><td>الإجمالي</td><td class="n">${T.visits + T.admissions}</td><td class="n">${m(T.total)} ${R.money.symbol}</td></tr></tbody></table>
  <div style="margin-top:10px;padding:8px 10px;background:#faf4ef;border-radius:6px;font-weight:700;font-size:13px">فقط ${esc(T.words.replace(/^فقط\s*/, ''))}</div>
  ${c.note ? `<p style="margin-top:10px">ملاحظات: ${esc(c.note)}</p>` : ''}
  <p style="margin-top:14px;font-size:13px">برجاء التكرم بمراجعة المطالبة وسداد قيمتها بشيك باسم المستشفى. مرفق البيان التفصيلي (${d.cases.length} حالة).<br>وتفضلوا بقبول فائق الاحترام،</p>
  <div style="flex:1"></div>
  <div class="foot"><span class="sign">حسابات التعاقدات</span><span class="sign">المدير المالي</span><span class="sign">مدير المستشفى</span></div></div>`;
    const detail = `<div class="sheet" style="width:194mm;page-break-before:always">
  ${head('البيان التفصيلي', `${c.payer.name} · ${c.periodName} · مطالبة ${c.no}`, '')}
  ${d.cases.map((x, i) => `<div class="sec" style="break-inside:avoid-page">
    <h3>${i + 1}. ${esc(x.patient.name)} <span>${x.kind === 'visit' ? 'خارجي · ' + esc(x.ref.typeName) + ' · زيارة ' + x.ref.no : 'داخلي · ' + esc(x.ref.typeName) + ' · دخول ' + x.ref.no + ' · من ' + dd(x.ref.date?.slice(0, 10)) + ' لـ ' + dd(x.ref.out?.slice(0, 10))}</span></h3>
    <div style="display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11px;color:#3d2f2a;margin-bottom:3px"><span>الكارنيه: <b>${esc(x.cardNo || '—')}</b></span>${x.tier ? `<span>الدرجة: <b>${esc(x.tier)}</b></span>` : ''}<span>التشخيص: <b>${esc(x.diagnosis || '—')}</b></span><span>ملف: ${x.patient.no}</span></div>
    <table><thead><tr><th style="width:13%">التاريخ</th><th>الخدمة</th><th class="n" style="width:7%">العدد</th><th class="n" style="width:13%">القيمة</th><th class="n" style="width:14%">على الجهة</th></tr></thead><tbody>
    ${x.lines.map((l) => `<tr><td>${dd(l.date)}</td><td>${esc(l.text)}</td><td class="n">${l.qty}</td><td class="n">${l.full ? m(l.full) : ''}</td><td class="n"><b>${m(l.amount)}</b></td></tr>`).join('')}
    <tr class="sub"><td colspan="4">إجمالي الحالة</td><td class="n">${m(x.total)}</td></tr></tbody></table></div>`).join('')}
  <div class="grand" style="grid-template-columns:repeat(3,1fr)"><div><small>الخارجي</small><b>${m(T.visitsAmount)}</b></div><div><small>الداخلي</small><b>${m(T.admissionsAmount)}</b></div><div class="net"><small>إجمالي المطالبة</small><b>${m(T.total)} ${R.money.symbol}</b></div></div>
  <div class="foot"><span class="sign">حسابات التعاقدات</span><span class="sign">المراجعة</span></div></div>`;
    res.type('html').send(page({ title: `مطالبة ${c.no} · ${c.payer.name}`, size: 'A4 portrait', body: draft + (req.query.part === 'detail' ? '' : cover) + (req.query.part === 'cover' ? '' : detail), auto: req.query.auto === '1' }));
  });

  // تقرير الخزينة اليومي (A4)
  r.get('/treasury', async (req, res) => {
    need(req.user, 'reports.treasury');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    const rep = await treasuryReport(db, { date, shiftId: req.query.shift ? intId(req.query.shift) : null });
    const t = rep.totals;
    const body = `<div class="sheet" style="width:194mm">
  ${head('تقرير الخزينة اليومي', rep.date ? dayName(rep.date) + (rep.shiftId ? ' · ' + (rep.shifts[0]?.labelName || '') + ' · ' + (rep.shifts[0]?.name || '') : '') : '', '')}
  ${rep.sections.map((s) => `<div class="sec"><h3>${esc(s.name)} <span>${s.totals.count} إيصال</span></h3>
    <table><thead><tr><th style="width:9%">الإيصال</th><th style="width:9%">اليدوي</th><th style="width:8%">الوقت</th><th style="width:22%">المريض</th><th>الخدمة</th><th class="n">نقدي</th><th class="n">فيزا</th><th class="n">آجل</th><th class="n">القيمة</th></tr></thead><tbody>
    ${s.rows.map((x) => `<tr class="${x.net < 0 ? 'out' : ''}"><td>${x.no}${x.net < 0 ? ' <small>(' + x.kindName + ')</small>' : ''}</td><td>${esc(x.manualNo || '')}</td><td style="white-space:nowrap">${time(x.at)}</td><td>${esc(x.patient)}</td><td>${esc(x.service)}</td>
      <td class="n">${x.cash ? m(x.cash) : ''}</td><td class="n">${x.card ? m(x.card) : ''}</td><td class="n">${x.credit ? m(x.credit) : ''}</td><td class="n"><b>${m(x.net)}</b></td></tr>`).join('')}
    <tr class="sub"><td colspan="5">إجمالي ${esc(s.name)}</td><td class="n">${m(s.totals.cash)}</td><td class="n">${m(s.totals.card)}</td><td class="n">${m(s.totals.credit)}</td><td class="n">${m(s.totals.net)}</td></tr>
    </tbody></table></div>`).join('') || '<p style="text-align:center;color:#6b5a54;padding:30px">مفيش إيصالات</p>'}
  <div class="grand"><div><small>عدد الإيصالات</small><b>${t.count}</b></div><div><small>نقدي</small><b>${m(t.cash)}</b></div><div><small>فيزا</small><b>${m(t.card)}</b></div>
    <div><small>آجل${t.discount ? ' · خصومات ' + m(t.discount) : ''}</small><b>${m(t.credit)}</b></div><div class="net"><small>الصافي${t.out ? ' (بعد مرتجعات ' + m(t.out) + ')' : ''}</small><b>${m(t.net)} ${R.money.symbol}</b></div></div>
  ${rep.shifts.length ? `<div class="sec"><h3>الورديات</h3><table><thead><tr><th>الوردية</th><th>الموظف</th><th>من</th><th>لحد</th><th class="n">المفروض</th><th class="n">اتسلّم</th></tr></thead><tbody>
    ${rep.shifts.map((x) => `<tr><td>${esc(x.labelName)}</td><td>${esc(x.name)}</td><td>${time(x.openedAt)}</td><td>${x.closedAt ? time(x.closedAt) : 'مفتوحة'}</td><td class="n">${x.expected == null ? '—' : m(x.expected)}</td><td class="n">${x.counted == null ? '—' : m(x.counted)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  <div class="foot"><span class="sign">أمين الخزينة</span><span class="sign">المراجع</span><span class="sign">المدير</span></div>
</div>`;
    res.type('html').send(page({ title: 'تقرير الخزينة ' + (rep.date || ''), size: 'A4 portrait', body, auto: req.query.auto === '1' }));
  });

  // إيصال تسليم الوردية
  r.get('/shift/:id', async (req, res) => {
    const s = await shiftSummary(db, intId(req.params.id));
    if (s.user.id !== req.user.id && s.handedTo?.id !== req.user.id) need(req.user, 'reports.treasury');
    const body = `<div class="sheet" style="width:128mm">
  ${head('تسليم وردية', `${s.labelName} · ${dayName(s.businessDate)}`, `<span style="font-size:12px">${esc(s.user.name)}</span>`)}
  <div class="kv"><div><i>من</i><b>${time(s.openedAt)}</b></div><div><i>لحد</i><b>${s.closedAt ? time(s.closedAt) : 'مفتوحة'}</b></div>
    <div><i>عدد الإيصالات</i><b>${s.receipts}</b></div><div><i>مرتجعات</i><b>${s.outs}</b></div></div>
  <table><tbody>
    <tr><td>نقدي محصّل</td><td class="n">${m(s.cashIn)}</td></tr>
    ${s.cashOut ? `<tr class="out"><td>نقدي مصروف (مرتجعات)</td><td class="n">- ${m(s.cashOut)}</td></tr>` : ''}
    ${s.vouchers ? `<tr class="out"><td>إذون صرف من الدرج (${s.voucherCount})</td><td class="n">- ${m(s.vouchers)}</td></tr>` : ''}
    ${s.received.map((x) => `<tr><td>استلام من ${esc(x.name)} ${esc(x.label)}</td><td class="n">${m(x.cash)}</td></tr>`).join('')}
    <tr class="sub"><td>النقدية المفروضة</td><td class="n">${m(s.expected)}</td></tr>
    <tr class="sub"><td>النقدية اللي اتسلّمت</td><td class="n">${s.counted == null ? '—' : m(s.counted)}</td></tr>
    ${s.diff ? `<tr class="out"><td>الفرق${s.diffReason ? ' · ' + esc(s.diffReason) : ''}</td><td class="n">${m(s.diff)}</td></tr>` : ''}
    <tr><td>فيزا</td><td class="n">${m(s.card)}</td></tr><tr><td>آجل</td><td class="n">${m(s.credit)}</td></tr>${s.discount ? `<tr><td>خصومات</td><td class="n">${m(s.discount)}</td></tr>` : ''}
  </tbody></table>
  ${s.note ? `<p style="font-size:11px;color:#6b5a54">ملاحظة: ${esc(s.note)}</p>` : ''}
  <div class="foot"><span class="sign">المسلّم: ${esc(s.user.name)}</span><span class="sign">المستلم: ${esc(s.handedTo?.name || '')}${s.receivedAt ? ' ✓' : ''}</span></div>
</div>`;
    res.type('html').send(page({ title: 'تسليم وردية', size: 'A5 portrait', body, auto: req.query.auto === '1' }));
  });

  // إذن الدفع (المريض ياخده للخزينة)
  r.get('/order/:id', async (req, res) => {
    need(req.user, 'receipts.read');
    const o = await db.one(`SELECT o.*, p.FullName, p.PatientNo, u.FullName AS ByName FROM PayOrders o JOIN Patients p ON p.Id = o.PatientId JOIN Users u ON u.Id = o.CreatedBy WHERE o.Id = ?`, [intId(req.params.id)]);
    if (!o) throw notFound('الإذن مش موجود');
    const amt = cents(o.Amount);
    const body = `<div class="sheet" style="width:76mm;padding:4mm">
  <div style="text-align:center"><img src="/brand/logo" alt="" style="width:38px"><div style="font-weight:800;color:${R.brand.primary}">${esc(R.brand.name)}</div>
  <div style="margin:6px 0 2px;font-weight:800">${amt < 0 ? 'إذن صرف' : 'إذن دفع'} · ${esc(ORDER_KINDS[o.Kind])}</div>
  <div style="font-size:40px;font-weight:800;line-height:1.1;border:2px solid #1d1412;border-radius:10px;padding:2px 0;margin:4px 12mm">${o.OrderNo}</div></div>
  <div class="kv" style="grid-template-columns:1fr"><div><i>المريض</i><b>${esc(o.FullName)}</b></div><div><i>رقم الملف</i><b>${o.PatientNo}</b></div><div><i>البيان</i><span style="text-align:left">${esc(o.Description)}</span></div></div>
  <div style="display:flex;justify-content:space-between;align-items:center;background:#1d1412;color:#fff;border-radius:8px;padding:6px 10px;font-weight:800;font-size:16px"><span>${amt < 0 ? 'يُصرف للمريض' : 'المطلوب'}</span><span>${money(Math.abs(amt))} ${R.money.symbol}</span></div>
  ${cents(o.Credit) ? `<div style="font-size:11px;margin-top:4px">آجل متوافق عليه: ${money(cents(o.Credit))} ${R.money.symbol}</div>` : ''}
  <p style="text-align:center;font-weight:700;margin:8px 0 0">${amt < 0 ? 'اتفضل الخزينة لاستلام المبلغ' : 'اتفضل ادفع في الخزينة'}</p>
  <p style="text-align:center;font-size:10.5px;color:#6b5a54;margin:2px 0 0">${esc(o.ByName)} · ${when(toIso(o.CreatedAt))}</p>
</div>`;
    res.type('html').send(page({ title: 'إذن ' + o.OrderNo, size: '80mm auto', body, auto: req.query.auto === '1' }));
  });

  // تقرير الأشعة (A4)
  r.get('/rad/:key', async (req, res) => {
    need(req.user, 'rad.read');
    const m0 = /^([va])(\d+)$/.exec(req.params.key || '');
    if (!m0) throw notFound('الفحص مش موجود');
    const col = m0[1] === 'v' ? 'VisitItemId' : 'AdmissionItemId';
    const s = await db.one(`SELECT s.*, p.FullName, p.PatientNo, p.Sex, p.BirthDate, p.AgeYears, p.AgeRecordedAt FROM RadStudies s JOIN Patients p ON p.Id = s.PatientId
      WHERE s.${col} = ? AND s.Status <> 'cancelled'`, [Number(m0[2])]);
    if (!s || (!s.ReportHtml && !s.ReportFile)) throw notFound('التقرير لسه ما اتكتبش');
    if (!s.ReportHtml && s.ReportFile) return res.redirect(`/api/radiology/${req.params.key}/file`);
    const ref = m0[1] === 'v'
      ? await db.one('SELECT d.Name FROM VisitItems i LEFT JOIN Doctors d ON d.Id = i.DoctorId WHERE i.Id = ?', [Number(m0[2])])
      : await db.one('SELECT d.Name FROM AdmissionItems i JOIN Admissions a ON a.Id = i.AdmissionId LEFT JOIN Doctors d ON d.Id = a.DoctorId WHERE i.Id = ?', [Number(m0[2])]);
    await db.run('UPDATE RadStudies SET PrintCount = PrintCount + 1 WHERE Id = ?', [s.Id]);
    const age = ageText(toDateStr(s.BirthDate), s.AgeYears, s.AgeRecordedAt);
    const enDate = (d) => d ? new Intl.DateTimeFormat('en-GB', { timeZone: R.tz, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(d)) : '';
    const final = ['reported', 'delivered'].includes(s.Status);
    const body = `<div class="sheet rad" style="width:194mm">
  ${head('تقرير أشعة', `${MODS[s.Modality] || ''} · فحص رقم ${s.StudyNo}`, '<span style="font-size:11px;color:#6b5a54">Radiology Department</span>')}
  <div class="kv" style="grid-template-columns:1fr 1fr 1fr">
    <div><i>المريض</i><b>${esc(s.FullName)}</b></div><div><i>رقم الملف</i><b>${s.PatientNo}</b></div><div><i>السن / النوع</i><span>${esc(age || '—')} · ${s.Sex === 'F' ? 'أنثى' : 'ذكر'}</span></div>
    <div><i>الفحص</i><span>${esc(s.ServiceName)}</span></div><div><i>التاريخ</i><span>${enDate(s.DoneAt || s.CreatedAt)}</span></div><div><i>الطبيب المحوّل</i><span>${esc(ref?.Name || '—')}</span></div>
  </div>
  ${!final ? '<div style="text-align:center;color:#a12a2a;font-weight:800;border:2px dashed #a12a2a;border-radius:8px;padding:4px;margin:6px 0">مسودة — لم يُعتمد بعد</div>' : ''}
  <div class="rbody" dir="ltr">
    ${s.ReportTitle ? `<h2>${esc(s.ReportTitle)}</h2>` : ''}
    ${s.ClinicalInfo ? `<p class="ci"><b>Clinical data:</b> ${esc(s.ClinicalInfo)}</p>` : ''}
    ${s.ReportHtml}
  </div>
  <div class="rsign"><div dir="ltr"><b>${esc(s.Radiologist || '')}</b><span>Radiologist</span></div>${final ? `<small>${enDate(s.ReportedAt)}</small>` : ''}</div>
</div>`;
    res.type('html').send(page({
      title: `تقرير أشعة ${s.StudyNo}`, size: 'A4 portrait', body, auto: req.query.auto === '1',
      extraCss: `.rbody{font-family:Arial,Helvetica,Cairo,sans-serif;font-size:13.5px;line-height:1.75;margin-top:12px;min-height:150mm}
.rbody h2{text-align:center;font-size:16px;text-decoration:underline;margin:4px 0 14px;font-weight:800}
.rbody p{margin:0 0 7px}.rbody ul,.rbody ol{margin:4px 0 8px;padding-left:22px}.rbody .ci{color:#444}
.rbody [dir=rtl]{font-family:Cairo,sans-serif}
.rsign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:20px;border-top:1px solid #eadfd6;padding-top:8px}
.rsign div{text-align:left}.rsign b{display:block;font-size:14px}.rsign span{color:#6b5a54;font-size:11.5px}.rsign small{color:#6b5a54}`,
    }));
  });

  // تقرير المعمل (A4): كل تحاليل المريض في الزيارة في ورقة واحدة
  r.get('/lab/:gkey', async (req, res) => {
    need(req.user, 'lab.read');
    const g = await labGroupDetail(db, req.params.gkey);
    const want = req.query.keys ? new Set(String(req.query.keys).split(',')) : null;
    let tests = g.tests.filter((t) => (!want || want.has(t.key)) && ['done', 'verified', 'delivered'].includes(t.status) && !t.hasFile);
    const files = g.tests.filter((t) => (!want || want.has(t.key)) && t.hasFile);
    if (!tests.length && files.length === 1) return res.redirect(`/api/lab/w/${files[0].key}/file`);
    if (!tests.length) throw notFound('مفيش نتايج جاهزة للطباعة');
    const draft = tests.some((t) => t.status === 'done');
    const work = await db.query(`SELECT Id FROM LabWork WHERE Id IN (${tests.map(() => '?').join(',')})`, tests.map((t) => t.workId));
    if (work.length) await db.run(`UPDATE LabWork SET PrintCount = PrintCount + 1 WHERE Id IN (${work.map(() => '?').join(',')})`, work.map((w) => w.Id));
    const enDate = (d) => d ? new Intl.DateTimeFormat('en-GB', { timeZone: R.tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '';
    const p = g.patient;
    const sections = [];
    for (const t of tests) { let sct = sections.find((x) => x.key === t.section); if (!sct) sections.push(sct = { key: t.section, tests: [] }); sct.tests.push(t); }
    const verifier = [...new Set(tests.map((t) => t.verifiedBy).filter(Boolean))].join(' / ');
    const flagCls = (f) => (f === 'H' ? 'hi' : f === 'L' ? 'lo' : f === 'A' ? 'ab' : '');
    const body = `<div class="sheet lab" style="width:194mm">
  ${head('تقرير التحاليل', `المعمل · عينة رقم ${g.accNo || '—'}`, `<span style="font-size:11px;color:#6b5a54">Laboratory Report</span>`)}
  <div class="kv" style="grid-template-columns:1fr 1fr 1fr">
    <div><i>المريض</i><b>${esc(p.name)}</b></div><div><i>رقم الملف</i><b>${p.no}</b></div><div><i>السن / النوع</i><span>${p.age != null ? (p.age < 1 ? Math.round(p.age * 12) + ' شهر' : Math.floor(p.age) + ' سنة') : '—'} · ${p.sex === 'F' ? 'أنثى' : 'ذكر'}</span></div>
    <div><i>الطبيب</i><span>${esc(g.doctor || '—')}</span></div><div><i>سحب العينة</i><span>${enDate(tests[0].collectedAt)}</span></div><div><i>التقرير</i><span>${enDate(tests.map((t) => t.verifiedAt || t.enteredAt).filter(Boolean).sort().at(-1))}</span></div>
  </div>
  ${draft ? '<div style="text-align:center;color:#a12a2a;font-weight:800;border:2px dashed #a12a2a;border-radius:8px;padding:4px;margin:6px 0">نتيجة مبدئية — لم تُعتمد بعد</div>' : ''}
  <div dir="ltr" class="lbody">
  ${sections.map((sc) => `<div class="lsec"><div class="lsech">${SECTION_EN[sc.key] || ''}</div>
    ${sc.tests.map((t) => `<table class="lt"><thead><tr><th class="tn" colspan="4">${esc(t.testName || t.service)}</th></tr>
      <tr class="cols"><th>Test</th><th>Result</th><th>Unit</th><th>Reference range</th></tr></thead><tbody>
      ${t.values.filter((v, i, arr) => { if (v.kind !== 'header') return !!v.value; const j = arr.slice(i + 1).findIndex((x) => x.kind === 'header'); return arr.slice(i + 1, j === -1 ? arr.length : i + 1 + j).some((x) => x.value); }).map((v) => v.kind === 'header' ? `<tr class="hd"><td colspan="4">${esc(v.name)}</td></tr>`
        : `<tr class="${flagCls(v.flag)}"><td>${esc(v.name)}</td><td class="rv">${esc(v.value || '')}${v.flag && v.flag !== 'A' ? ` <b class="fl">${v.flag}</b>` : v.flag === 'A' ? ' <b class="fl">*</b>' : ''}</td><td>${esc(v.unit || '')}</td><td class="rf">${esc(v.refText || '')}</td></tr>`).join('')}
      </tbody></table>${t.comment ? `<p class="cm"><b>Comment:</b> ${esc(t.comment)}</p>` : ''}`).join('')}</div>`).join('')}
  </div>
  ${files.length ? `<p style="font-size:11px;color:#6b5a54">تحاليل من معمل خارجي مرفقة منفصلة: ${files.map((f) => esc(f.service)).join('، ')}</p>` : ''}
  <div class="rsign"><div dir="ltr"><b>${esc(verifier || '')}</b><span>${draft ? 'Lab technician' : 'Clinical pathologist'}</span></div><small dir="ltr">H = High · L = Low · * = Abnormal</small></div>
</div>`;
    res.type('html').send(page({
      title: `تحاليل ${p.name}`, size: 'A4 portrait', body, auto: req.query.auto === '1',
      extraCss: `.lbody{font-family:Arial,Helvetica,Cairo,sans-serif;font-size:12.5px;margin-top:8px;min-height:160mm}
.lsec{margin-bottom:10px}.lsech{font-weight:800;font-size:12px;letter-spacing:1px;color:${R.brand.primary};border-bottom:1.5px solid ${R.brand.primary};padding:2px 0;margin:6px 0 4px}
table.lt{margin-bottom:8px;break-inside:avoid}table.lt th{background:none;color:#1d1412;text-align:left;font-size:11.5px;border-bottom:1px solid #d9c6b8}
table.lt th.tn{font-size:13px;background:#faf4ef;padding:4px 6px}table.lt tr.cols th{color:#6b5a54;font-weight:700}
table.lt td{font-size:12px;padding:3px 6px}table.lt td.rv{font-weight:700}table.lt td.rf{color:#555}
table.lt tr.hi td.rv,table.lt tr.lo td.rv,table.lt tr.ab td.rv{color:#b00000}.fl{font-size:10.5px;border:1px solid currentColor;border-radius:4px;padding:0 3px}
table.lt tr.hd td{font-weight:800;font-style:italic;background:#fcfaf8}
.cm{font-size:11.5px;margin:0 0 8px}
.rsign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px;border-top:1px solid #eadfd6;padding-top:8px}
.rsign div{text-align:left}.rsign b{display:block;font-size:14px}.rsign span{color:#6b5a54;font-size:11.5px}.rsign small{color:#6b5a54}`,
    }));
  });

  // ملصقات العينات (باركود): ملصق لكل أنبوبة
  r.get('/lab-labels/:gkey', async (req, res) => {
    need(req.user, 'lab.read');
    const g = await labGroupDetail(db, req.params.gkey);
    const tests = g.tests.filter((t) => t.accNo && ['collected', 'sent', 'done', 'verified'].includes(t.status));
    if (!tests.length) throw notFound('اسحب العينة الأول');
    const tubes = new Map();
    for (const t of tests) { const k = `${t.accNo}|${t.tube || t.sample}`; if (!tubes.has(k)) tubes.set(k, { acc: t.accNo, tube: t.tube || t.sample, codes: [] }); tubes.get(k).codes.push(t.code || t.service); }
    const p = g.patient;
    const body = [...tubes.values()].map((x) => `<div class="lbl"><div class="ln"><b>${esc(p.name)}</b><span>${p.no}</span></div>
      <div class="bc">${code128Svg(String(x.acc), { height: 34, module: 1.4 })}</div>
      <div class="ln"><b dir="ltr">${x.acc}</b><span dir="ltr">${esc(x.tube)}</span></div><div class="tc" dir="ltr">${esc(x.codes.join(' · '))}</div></div>`).join('');
    res.type('html').send(page({
      title: `ملصقات ${g.accNo}`, size: '50mm 25mm', body: `<div class="labels">${body}</div>`, auto: req.query.auto === '1',
      extraCss: `@page{size:50mm 25mm;margin:0}.labels{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;padding:10px}
.lbl{width:50mm;height:25mm;background:#fff;padding:1.2mm 2mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.15)}
.ln{display:flex;justify-content:space-between;gap:4px;font-size:8.5px;line-height:1.2;white-space:nowrap;overflow:hidden}.ln b{font-size:9px;overflow:hidden;text-overflow:ellipsis}
.bc{height:9mm}.bc svg{height:9mm}.tc{font-size:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:Arial}
@media print{.labels{display:block;padding:0}.lbl{box-shadow:none;page-break-after:always}}`,
    }));
  });

  return r;
}
