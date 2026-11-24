// الخزينة: أذونات الدفع المستنية، التحصيل والإيصال اليدوي، والوردية والتسليم
import {
  api, html, icon, $, $$, money, egp, fmtTime, ago, initials, modal, toast, toastError, askReason, printReceipt, printShift,
  can, debounce, ApiError, state,
} from '../core.js';

const KIND_IC = { visit: 'clipboard', adm_pay: 'bed', deposit: 'shield', discharge: 'exit', refund_due: 'undo' };
const autoPrint = () => localStorage.getItem('autoPrint') !== '0';

export async function renderCashier(view, { setTitle }) {
  setTitle('الخزينة', 'أذونات الدفع اللي جاية من الاستقبال');
  const S = { q: '', orders: [], mine: null, busy: false, timer: null, seen: new Set(), first: true };
  view.innerHTML = String(html`
    <div id="shiftbox"></div>
    <div id="handbox"></div>
    <section class="card pad cq">
      <div class="cqhead">
        <h3 style="margin:0">${icon('wallet')} مستني الدفع <b class="badge py num" id="qn">0</b></h3>
        <span class="muted" id="qsum" style="font-weight:700"></span>
        <div class="big-search cqsearch">${icon('search')}<input class="input" id="oq" inputmode="numeric" autocomplete="off" placeholder="رقم الإذن أو اسم المريض ← Enter" style="height:46px;font-size:15px;padding-inline-start:42px;border-radius:14px"></div>
      </div>
      <div id="ql"><div class="skel" style="height:200px"></div></div>
    </section>
    <section class="card pad" style="margin-top:14px"><div class="row" style="gap:8px"><h3 style="margin:0">${icon('receipt')} اتحصّل النهارده</h3><span class="spacer"></span><a class="linkbtn" href="#/reports">تقرير الخزينة ←</a></div><div id="dl" style="margin-top:8px"></div></section>`);

  const drawShift = () => {
    const m = S.mine;
    const sh = m?.shift;
    $('#shiftbox', view).innerHTML = String(!sh ? html`<div class="card shiftcta">
        <span class="pic" style="width:54px;height:54px;border-radius:16px">${icon('wallet')}</span>
        <div><b style="font-size:17px">ابدأ وردية ${HMS.shiftNames[m?.label] || ''}</b>
          <div class="muted" style="font-weight:600">طول ما ورديتك مفتوحة، الاستقبال بيبعتلك أذونات الدفع بدل ما يقبض.</div></div>
        <button class="btn lg" id="openShift" style="margin-inline-start:auto;--c:var(--py)">${icon('check')} ابدأ الوردية</button></div>`
      : html`<div class="card shiftnow">
        <div class="sn-who"><span class="avatar" style="width:46px;height:46px">${initials(sh.user.name)}</span><div><b>وردية ${sh.labelName}</b><small>من ${fmtTime(sh.openedAt)} · ${sh.receipts} إيصال</small></div></div>
        <div class="sn-tiles">
          <div><small>نقدي في الدرج</small><b class="num">${money(sh.expected)}</b></div>
          <div><small>فيزا</small><b class="num">${money(sh.card)}</b></div>
          ${sh.receivedCash ? html`<div><small>استلمت</small><b class="num">${money(sh.receivedCash)}</b></div>` : ''}
          ${sh.cashOut ? html`<div><small>صرفت</small><b class="num" style="color:var(--danger)">${money(sh.cashOut)}</b></div>` : ''}
          ${sh.vouchers ? html`<div><small>إذون صرف</small><b class="num" style="color:var(--danger)">${money(sh.vouchers)}</b></div>` : ''}
        </div>
        <button class="btn ghost" id="closeShift">${icon('lock')} قفّل الوردية وسلّم</button></div>`);
    const hv = m?.handovers || [];
    $('#handbox', view).innerHTML = hv.length ? String(html`<div class="handlist">${hv.map((h) => html`<div class="card handitem">
        <span class="pic" style="background:var(--warn-soft);color:#8a5200">${icon('arrows')}</span>
        <div style="min-width:0"><b>${h.user.name} مسلّمك وردية ${h.labelName}</b><small>اتقفلت ${fmtTime(h.closedAt)}${h.diff ? ` · فرق ${money(h.diff)}` : ''}</small></div>
        <b class="num" style="font-size:20px;margin-inline-start:auto">${money(h.counted)} ${HMS.money.symbol}</b>
        <button class="btn ghost sm" data-hprint="${h.id}">${icon('print', 'sm')}</button>
        <button class="btn sm" data-receive="${h.id}" style="--c:var(--ok)">${icon('check', 'sm')} استلمت</button></div>`)}</div>`) : '';
  };

  const drawQueue = () => {
    const q = S.q.trim();
    const list = S.orders.filter((o) => !q || String(o.no) === q || o.patient.name.includes(q) || String(o.patient.no) === q);
    $('#qn', view).textContent = S.orders.length;
    const sum = S.orders.reduce((a, o) => a + HMS.money.toMinor(o.amount), 0) / HMS.money.F;
    $('#qsum', view).textContent = S.orders.length ? `الإجمالي ${money(sum)} ${HMS.money.symbol}` : '';
    $('#ql', view).innerHTML = list.length ? String(html`<div class="ogrid">${list.map((o) => html`
      <button class="ocard ${o.amount < 0 ? 'out' : ''} ${S.seen.has(o.id) ? '' : 'fresh'}" data-o="${o.id}">
        <span class="ono num">${o.no}</span>
        <div class="obody"><b>${o.patient.name}</b>
          <small>${icon(KIND_IC[o.kind], 'sm')} ${o.kindName}${o.payer ? html` · <span style="color:var(--py)">${o.payer}</span>` : ''}</small>
          <small class="odesc">${o.description}</small>
          <small class="muted">${o.createdBy} · ${ago(o.createdAt)}</small></div>
        <div class="oamt"><small>${o.amount < 0 ? 'صرف' : 'المطلوب'}</small><b class="num">${money(Math.abs(o.amount))}</b>${o.credit ? html`<small>آجل ${money(o.credit)}</small>` : ''}</div>
      </button>`)}</div>`)
      : String(html`<div class="empty" style="padding:30px 10px"><div class="art" style="background:var(--py-soft);color:var(--py)">${icon('check')}</div><b>${q ? 'مفيش إذن بالرقم ده' : 'مفيش أذونات مستنية'}</b>${q ? '' : 'أول ما الاستقبال يعمل إذن هيظهر هنا لوحده'}</div>`);
    for (const o of S.orders) S.seen.add(o.id);
  };

  const drawDone = async () => {
    const r = await api.get('/orders?status=done');
    const mine = r.orders.filter((o) => o.doneBy === state.me.name).slice(0, 12);
    $('#dl', view).innerHTML = mine.length ? String(html`<div class="table-wrap"><table class="table"><thead><tr><th>الإذن</th><th>المريض</th><th class="hide-sm">البيان</th><th>الإيصال</th><th class="n">المبلغ</th><th></th></tr></thead><tbody>
      ${mine.map((o) => html`<tr><td class="num">${o.no}</td><td><b>${o.patient.name}</b></td><td class="hide-sm" style="max-width:340px">${o.description}</td><td class="num">${o.receiptNo}</td><td class="n">${egp(o.amount)}</td>
        <td class="n"><button class="btn ghost icon sm" data-rprint="${o.receiptId}">${icon('print', 'sm')}</button></td></tr>`)}</tbody></table></div>`)
      : String(html`<div class="muted" style="font-weight:600;padding:6px">لسه مفيش</div>`);
  };

  const load = async () => {
    const [o, m] = await Promise.all([api.get('/orders'), api.get('/shifts/mine')]);
    const fresh = o.orders.some((x) => !S.seen.has(x.id)) && !S.first;
    S.orders = o.orders; S.mine = m; S.manualReq = o.manualNoRequired; S.first = false;
    drawShift(); drawQueue();
    if (fresh) { toast('إذن دفع جديد', 'info'); try { navigator.vibrate?.(80); } catch { /* */ } }
  };

  const collect = (o) => {
    const out = o.amount < 0;
    const X = { method: 'cash', given: '', split: '', manual: '' };
    const m = modal({
      title: `${out ? 'صرف' : 'تحصيل'} إذن ${o.no}`,
      body: html`<div class="pricehead" style="--ds:var(--py-soft);--dc:var(--py)"><span class="dicon">${icon(KIND_IC[o.kind])}</span><div><b>${o.patient.name}</b><small>ملف <span class="num">${o.patient.no}</span> · ${o.kindName} · من ${o.createdBy}</small></div>
          <div class="cur"><small>${out ? 'يُصرف' : 'المطلوب'}</small><b class="num">${money(Math.abs(o.amount))} ${HMS.money.symbol}</b></div></div>
        <div class="muted" style="font-size:13px;font-weight:600;margin:10px 2px">${o.description}${o.discount ? ` · خصم ${money(o.discount)}` : ''}${o.credit ? ` · آجل ${money(o.credit)}` : ''}</div>
        <div id="cx"></div>`,
      foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-go style="--c:${out ? 'var(--danger)' : 'var(--ok)'}">${icon(out ? 'undo' : 'check')} ${out ? 'اصرف واطبع' : 'حصّل واطبع الإيصال'}</button>`,
    });
    const draw = () => {
      const amt = o.amount;
      const change = X.method === 'cash' && X.given !== '' ? Number(X.given) - amt : null;
      const splitCard = Math.max(0, HMS.money.round(amt - (Number(X.split) || 0)));
      $('#cx', m.el).innerHTML = String(html`
        ${!out ? html`<div class="seg full">${[['cash', 'نقدي', 'cash'], ['card', 'فيزا', 'card'], ['split', 'الاتنين', 'split']].map(([k, n, ic]) => html`<button data-m="${k}" class="${X.method === k ? 'on' : ''}">${icon(ic, 'sm')}${n}</button>`)}</div>
          ${X.method === 'cash' ? html`<div class="row" style="gap:8px;margin-top:10px"><input class="input num" name="given" inputmode="decimal" placeholder="المريض دفع كام؟" value="${X.given}" style="flex:1;height:48px;font-size:18px">
            ${[50, 100, 200, 500, 1000].filter((x) => x >= amt).slice(0, 3).map((x) => html`<button class="btn ghost sm" data-given="${x}"><span class="num">${x}</span></button>`)}</div>
            ${change != null ? html`<div class="change ${change < 0 ? 'neg' : ''}" style="margin-top:8px"><span>${change < 0 ? 'ناقص' : 'الباقي للمريض'}</span><b class="num" style="font-size:22px">${money(Math.abs(change))} ${HMS.money.symbol}</b></div>` : ''}` : ''}
          ${X.method === 'split' ? html`<div class="splitbox" style="margin-top:10px"><div class="field"><label>نقدي</label><input class="input num" name="split" value="${X.split}" inputmode="decimal"></div><div class="field"><label>فيزا</label><input class="input num" value="${money(splitCard)}" disabled></div></div>` : ''}` : ''}
        <div class="field" data-f="manualNo" style="margin-top:12px"><label>رقم الإيصال اليدوي ${S.manualReq ? html`<span class="req">*</span>` : html`<span class="hint">لو فيه</span>`}</label>
          <input class="input num" name="manual" value="${X.manual}" inputmode="numeric" style="height:48px;font-size:18px;font-weight:800"><div class="msg"></div></div>`);
    };
    draw();
    setTimeout(() => $(out ? '[name=manual]' : '[name=given]', m.el)?.focus(), 60);
    const upd = debounce((n, pos) => { draw(); const i = $(`[name=${n}]`, m.el); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch { /* */ } } }, 250);
    m.el.addEventListener('input', (e) => {
      const n = e.target.name; const v = e.target.value.replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632);
      if (n === 'manual') { X.manual = v; return; }
      if (n === 'given' || n === 'split') { X[n] = v; upd(n, e.target.selectionStart); }
    });
    const go = async () => {
      if (S.busy) return;
      const body = { manualNo: X.manual };
      if (!out) {
        if (X.method === 'cash') body.cash = o.amount;
        if (X.method === 'card') body.card = o.amount;
        if (X.method === 'split') { body.cash = Number(X.split) || 0; body.card = HMS.money.round((o.amount - body.cash)); if (body.card < 0) return toast('النقدي أكبر من المطلوب', 'err'); }
        if (X.method === 'cash' && X.given !== '' && Number(X.given) < o.amount) return toast('المبلغ اللي المريض دفعه أقل من المطلوب', 'err');
      }
      S.busy = true;
      try {
        const r = await api.post(`/orders/${o.id}/collect`, body);
        const change = X.method === 'cash' && X.given !== '' ? Number(X.given) - o.amount : 0;
        m.close();
        if (autoPrint()) printReceipt(r.receiptId, true);
        toast(out ? `اتصرف ${money(-o.amount)} ${HMS.money.symbol} · إذن ${o.no}` : `اتحصّل ${money(o.amount)} ${HMS.money.symbol}${change > 0 ? ` · الباقي ${money(change)}` : ''}`);
        await load(); drawDone(); window.refreshShell?.();
        $('#oq', view).value = ''; S.q = ''; drawQueue(); $('#oq', view).focus();
      } catch (er) {
        if (er instanceof ApiError && er.data.errors?.manualNo) { const f = $('[data-f=manualNo]', m.el); f.classList.add('err'); $('.msg', f).textContent = er.data.errors.manualNo; }
        if (er.status === 409) load();
        toastError(er);
      } finally { S.busy = false; }
    };
    m.el.addEventListener('click', (e) => {
      const mm = e.target.closest('[data-m]');
      if (mm) { X.method = mm.dataset.m; draw(); return; }
      const gv = e.target.closest('[data-given]');
      if (gv) { X.given = gv.dataset.given; draw(); return; }
      if (e.target.closest('[data-go]')) go();
    });
    m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); go(); } });
  };

  view.onclick = async (e) => {
    const t = e.target;
    if (t.closest('#openShift')) {
      try { await api.post('/shifts/open'); toast('الوردية بدأت. الأذونات هتوصلك هنا'); load(); window.refreshShell?.(); } catch (er) { toastError(er); }
      return;
    }
    if (t.closest('#closeShift')) { openShiftClose({ onDone: load }); return; }
    const oc = t.closest('[data-o]');
    if (oc) { const o = S.orders.find((x) => x.id === Number(oc.dataset.o)); if (o) collect(o); return; }
    const rv = t.closest('[data-receive]');
    if (rv) {
      try { await api.post(`/shifts/${rv.dataset.receive}/receive`); toast('اتسجل الاستلام، والمبلغ دخل درجك'); load(); } catch (er) { toastError(er); }
      return;
    }
    const hp = t.closest('[data-hprint]');
    if (hp) { printShift(hp.dataset.hprint); return; }
    const rp = t.closest('[data-rprint]');
    if (rp) printReceipt(rp.dataset.rprint, false);
  };
  view.oninput = (e) => { if (e.target.id === 'oq') { S.q = e.target.value.replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632); drawQueue(); } };
  view.onkeydown = (e) => {
    if (e.target.id === 'oq' && e.key === 'Enter') {
      const q = S.q.trim();
      const o = S.orders.find((x) => String(x.no) === q) || (S.orders.filter((x) => x.patient.name.includes(q)).length === 1 ? S.orders.find((x) => x.patient.name.includes(q)) : null);
      if (o) collect(o); else toast('مفيش إذن مستني بالرقم ده', 'warn');
    }
  };
  await load();
  drawDone();
  setTimeout(() => $('#oq', view)?.focus(), 50);
  S.timer = setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) load().catch(() => {}); }, 8000);
  return () => { clearInterval(S.timer); view.onclick = view.oninput = view.onkeydown = null; };
}

/** تقفيل ورديتي: عدّ النقدية، الفرق وسببه، وسلّم لمين */
export async function openShiftClose({ onDone } = {}) {
  const r = await api.get('/shifts/mine');
  const sh = r.shift;
  if (!sh) return toast('مفيش وردية مفتوحة. الوردية بتبدأ مع أول إيصال', 'info');
  const X = { counted: '', reason: '', to: r.receivers.find((u) => u.role === 'cashier' && u.id !== state.me.id)?.id || '', note: '' };
  const m = modal({
    title: `تقفيل وردية ${sh.labelName}`, wide: true,
    body: html`<div class="closesum">
        <div><small>نقدي محصّل</small><b class="num">${money(sh.cashIn)}</b></div>
        ${sh.cashOut ? html`<div><small>نقدي مصروف</small><b class="num" style="color:var(--danger)">- ${money(sh.cashOut)}</b></div>` : ''}
        ${sh.vouchers ? html`<div><small>إذون صرف (دكاترة · مصروفات · موردين)</small><b class="num" style="color:var(--danger)">- ${money(sh.vouchers)}</b></div>` : ''}
        ${sh.receivedCash ? html`<div><small>استلمت من ورديات</small><b class="num">${money(sh.receivedCash)}</b></div>` : ''}
        <div class="exp"><small>المفروض في الدرج</small><b class="num">${money(sh.expected)}</b></div>
        <div><small>فيزا</small><b class="num">${money(sh.card)}</b></div>
        ${sh.credit ? html`<div><small>آجل</small><b class="num">${money(sh.credit)}</b></div>` : ''}
      </div>
      ${sh.noManual && state.me.role === 'cashier' ? html`<div class="alertbar warn" style="margin-top:10px">${icon('info')}<span><b class="num">${sh.noManual}</b> إيصال من غير رقم يدوي</span></div>` : ''}
      <div id="cc" style="margin-top:12px"></div>`,
    foot: html`<button class="btn ghost" data-close>رجوع</button><button class="btn" data-go>${icon('lock')} قفّل واطبع التسليم</button>`,
  });
  const draw = () => {
    const diff = X.counted === '' ? null : HMS.money.round((Number(X.counted) - sh.expected));
    $('#cc', m.el).innerHTML = String(html`<div class="form-grid">
      <div class="field c3" data-f="counted"><label>النقدية اللي في الدرج فعلًا <span class="req">*</span></label>
        <div class="row" style="gap:6px"><input class="input num" name="counted" inputmode="decimal" value="${X.counted}" style="height:54px;font-size:22px;font-weight:800;flex:1">
        <button class="btn ghost sm" data-same>${icon('check', 'sm')} مظبوط</button></div><div class="msg"></div></div>
      <div class="field c3"><label>الفرق</label><div class="diffbox ${diff == null ? '' : diff === 0 ? 'ok' : diff < 0 ? 'neg' : 'pos'}">${diff == null ? '—' : diff === 0 ? html`${icon('check', 'sm')} مظبوط` : html`${diff < 0 ? 'عجز' : 'زيادة'} <b class="num">${money(Math.abs(diff))}</b> ${HMS.money.symbol}`}</div></div>
      ${diff ? html`<div class="field c6" data-f="diffReason"><label>سبب الفرق <span class="req">*</span></label><input class="input" name="reason" value="${X.reason}"><div class="msg"></div></div>` : ''}
      ${Number(X.counted) > 0 || X.counted === '' ? html`<div class="field c3" data-f="handedTo"><label>هتسلّم الفلوس لمين؟ <span class="req">*</span></label>
        <select class="select" name="to"><option value="">اختار</option>${r.receivers.map((u) => html`<option value="${u.id}" ${String(X.to) === String(u.id) ? 'selected' : ''}>${u.name} · ${({ cashier: 'خزينة', supervisor: 'مشرف', manager: 'مدير' })[u.role]}</option>`)}</select><div class="msg"></div></div>` : ''}
      <div class="field c3"><label>ملاحظة <span class="hint">اختياري</span></label><input class="input" name="note" value="${X.note}"></div></div>`);
  };
  draw();
  setTimeout(() => $('[name=counted]', m.el)?.focus(), 60);
  const upd = debounce((pos) => { draw(); const i = $('[name=counted]', m.el); i.focus(); try { i.setSelectionRange(pos, pos); } catch { /* */ } }, 300);
  m.el.addEventListener('input', (e) => {
    const n = e.target.name;
    if (n === 'counted') { X.counted = e.target.value.replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632); upd(e.target.selectionStart); }
    if (n === 'reason') X.reason = e.target.value;
    if (n === 'note') X.note = e.target.value;
  });
  m.el.addEventListener('change', (e) => { if (e.target.name === 'to') X.to = e.target.value; });
  m.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-same]')) { X.counted = String(sh.expected); draw(); return; }
    if (!e.target.closest('[data-go]')) return;
    $$('.field', m.el).forEach((f) => { f.classList.remove('err'); const x = $('.msg', f); if (x) x.textContent = ''; });
    try {
      const res = await api.post('/shifts/mine/close', { counted: X.counted, diffReason: X.reason, handedTo: X.to, note: X.note });
      m.close();
      printShift(res.shift.id);
      toast(res.shift.handedTo ? `الوردية اتقفلت. سلّم ${money(res.shift.counted)} ${HMS.money.symbol} لـ ${res.shift.handedTo.name}` : 'الوردية اتقفلت');
      window.refreshShell?.();
      onDone?.();
    } catch (er) {
      if (er instanceof ApiError && er.data.errors) {
        for (const [f, msg] of Object.entries(er.data.errors)) { const box = $(`[data-f="${f}"]`, m.el); if (box) { box.classList.add('err'); $('.msg', box).textContent = msg; } }
      }
      toastError(er);
    }
  });
}
void can; void askReason;
