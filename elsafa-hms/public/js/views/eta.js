// شاشة الإيصال الإلكتروني (مصلحة الضرايب): إعدادات المنشأة + قايمة المستندات والرفع
import { api, html, icon, $, $$, modal, toast, toastError, can, money, fmtDay } from '../core.js';

const ST = { incomplete: ['warn', 'بيانات ناقصة'], ready: ['', 'جاهز للرفع'], submitted: ['', 'اتبعت'], accepted: ['ok', 'اتقبل'], rejected: ['bad', 'اترفض'], failed: ['bad', 'فشل'], skipped: ['', 'متخطّى'] };
const fmtAt = (s) => (s ? new Date(s).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : '');

export async function renderEta(view, { setTitle }) {
  setTitle('الإيصال الإلكتروني', 'تجهيز ورفع الإيصالات لمصلحة الضرايب');
  let filter = '';
  const draw = async () => {
    const [c, d] = await Promise.all([api.get('/eta/config'), api.get('/eta/docs' + (filter ? '?status=' + filter : ''))]);
    const mg = can('eta.manage'), sb = can('eta.submit');
    const f = (k, label, ph = '', cls = '') => html`<div class="field ${cls}"><label>${label}</label><input class="input" data-f="${k}" value="${c[k] ?? ''}" placeholder="${ph}" ${mg ? '' : 'disabled'}></div>`;
    view.innerHTML = String(html`<div class="grid" style="gap:14px;max-width:1000px;margin:0 auto">
      ${c.enabled && c.missing.length ? html`<div class="alertbar warn">${icon('alert')}<span>ناقص في الإعدادات: ${c.missing.join('، ')}. الإيصالات هتتجهّز وتستنى لحد ما تكمّلهم.</span></div>` : ''}
      <div class="card pad">
        <div class="row wrap" style="gap:10px;align-items:center;margin-bottom:8px"><h3 style="margin:0">إعدادات المنشأة</h3>
          <span class="badge ${c.enabled ? 'ok' : ''}">${c.enabled ? 'شغّال' : 'مقفول'}</span><span class="badge">${c.envs[c.env]}</span></div>
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">
          ${f('rin', 'الرقم الضريبي')}${f('tradeName', 'الاسم التجاري')}${f('branchCode', 'كود الفرع', '0')}${f('activityCode', 'كود النشاط', '8610')}
          ${f('posSerial', 'الرقم التسلسلي لجهاز نقطة البيع (POS)')}${f('governate', 'المحافظة', 'دمياط')}${f('regionCity', 'المدينة / المنطقة')}${f('street', 'الشارع')}${f('buildingNumber', 'رقم المبنى')}
          ${f('itemCode', 'كود الصنف الافتراضي (EGS/GS1)', 'EG-…')}
          <div class="field"><label>نوع الكود</label><select class="input" data-f="itemType" ${mg ? '' : 'disabled'}><option ${c.itemType === 'EGS' ? 'selected' : ''}>EGS</option><option ${c.itemType === 'GS1' ? 'selected' : ''}>GS1</option></select></div>
          ${f('vatPct', 'ضريبة القيمة المضافة %', '0 = معفاة')}
          <div class="field"><label>البيئة</label><select class="input" data-f="env" ${mg ? '' : 'disabled'}>${Object.entries(c.envs).map(([k, v]) => html`<option value="${k}" ${c.env === k ? 'selected' : ''}>${v}</option>`)}</select></div>
          <div class="field"><label>طريقة الرفع</label><select class="input" data-f="mode" ${mg ? '' : 'disabled'}><option value="manual" ${c.mode === 'manual' ? 'selected' : ''}>يدوي (المحاسب يدوس رفع)</option><option value="auto" ${c.mode === 'auto' ? 'selected' : ''}>أوتوماتيك (بعد كل إيصال)</option></select></div>
          ${mg ? html`<div class="field"><label>Client ID <span class="hint">${c.hasClientId ? 'متسجّل ✓ (اكتب عشان تغيّره)' : ''}</span></label><input class="input" type="password" autocomplete="off" data-f="clientId" placeholder="${c.hasClientId ? '••••••••' : ''}"></div>
            <div class="field"><label>Client Secret <span class="hint">${c.hasClientSecret ? 'متسجّل ✓ (اكتب عشان تغيّره)' : ''}</span></label><input class="input" type="password" autocomplete="off" data-f="clientSecret" placeholder="${c.hasClientSecret ? '••••••••' : ''}"></div>` : ''}
        </div>
        ${mg ? html`<div class="row" style="gap:10px;margin-top:10px;align-items:center"><label class="check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="en" ${c.enabled ? 'checked' : ''}> <b>تشغيل الإيصال الإلكتروني</b></label>
          <button class="btn" id="sv" style="margin-inline-start:auto">${icon('check')} حفظ</button></div>
          <div class="muted" style="font-size:12.5px;margin-top:6px">بيانات الاعتماد بتتخزّن مشفّرة على الجهاز ده بس، ومتتبعتش في أي شات أو ملف. أول تشغيل بيجهّز الإيصالات من اللحظة دي وطالع (مش القديمة).</div>` : ''}
      </div>
      <div class="card pad">
        <div class="row wrap" style="gap:8px;align-items:center;margin-bottom:8px">
          ${['', 'incomplete', 'ready', 'accepted', 'failed', 'skipped'].map((k) => html`<button class="btn ${filter === k ? '' : 'ghost'} sm" data-fl="${k}">${k ? ST[k][1] : 'الكل'}${k && d.counts[k] ? ' (' + d.counts[k] + ')' : ''}</button>`)}
          ${sb && c.enabled ? html`<button class="btn sm" id="sa" style="margin-inline-start:auto">${icon('upload')} جهّز وارفع الجاهز</button>` : ''}</div>
        ${d.docs.length ? html`<div style="overflow:auto"><table class="tbl"><thead><tr><th>إيصال</th><th>المبلغ</th><th>الحالة</th><th>ملاحظة</th><th>وقت</th><th></th></tr></thead><tbody>
          ${d.docs.map((x) => html`<tr><td class="num">#${x.receiptNo}</td><td class="num">${money(x.net)}</td><td><span class="badge ${ST[x.status][0]}">${ST[x.status][1]}</span></td>
            <td style="max-width:300px;font-size:12.5px">${x.message || ''}</td><td class="num" style="font-size:12.5px">${fmtAt(x.createdAt)}</td>
            <td style="white-space:nowrap"><button class="btn ghost sm" data-v="${x.id}">عرض</button>${sb && ['ready', 'failed'].includes(x.status) ? html` <button class="btn sm" data-up="${x.id}">رفع</button>` : ''}</td></tr>`)}
        </tbody></table></div>` : html`<div class="muted" style="font-weight:700;text-align:center;padding:16px">مفيش مستندات</div>`}
      </div></div>`);
    $$('[data-fl]', view).forEach((b) => b.addEventListener('click', () => { filter = b.dataset.fl; draw(); }));
    $('#sv', view)?.addEventListener('click', async () => {
      const body = { enabled: $('#en', view).checked };
      $$('[data-f]', view).forEach((i) => { if (i.value !== '' || !/client/.test(i.dataset.f)) body[i.dataset.f] = i.value; });
      try { await api.put('/eta/config', body); toast('اتحفظ'); draw(); } catch (e) { toastError(e); }
    });
    $('#sa', view)?.addEventListener('click', async () => { try { const r = await api.post('/eta/submit-all', {}); toast(`اتقبل ${r.accepted || 0}${r.failed ? '، فشل ' + r.failed : ''}`); draw(); } catch (e) { toastError(e); } });
    $$('[data-up]', view).forEach((b) => b.addEventListener('click', async () => { try { const r = await api.post(`/eta/docs/${b.dataset.up}/submit`, {}); toast(r.status === 'accepted' ? 'اتقبل' : 'فشل. شوف الملاحظة', r.status === 'accepted' ? 'ok' : 'warn'); draw(); } catch (e) { toastError(e); } }));
    $$('[data-v]', view).forEach((b) => b.addEventListener('click', async () => {
      try {
        const { doc } = await api.get('/eta/docs/' + b.dataset.v);
        modal({ title: `إيصال #${doc.receiptNo}`, wide: true, body: html`<pre dir="ltr" style="max-height:60vh;overflow:auto;font-size:12px;background:var(--bg2,#f6f1f1);padding:10px;border-radius:8px">${JSON.stringify({ uuid: doc.uuid, status: doc.status, message: doc.message, payload: doc.payload, response: doc.response }, null, 2)}</pre>`, foot: html`<button class="btn ghost" data-close>قفل</button>` });
      } catch (e) { toastError(e); }
    }));
  };
  await draw();
}
