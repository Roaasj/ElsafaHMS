// تشغيل الواجهة: الدخول، الهيكل، التنقل، البحث العام، الاختصارات
import { state, api, applyBrand, refreshLookups, html, icon, el, $, $$, toast, debounce, initials, money, fmtDay, can, modal, ApiError, toastError } from './core.js';
import { renderSettings } from './views/settings.js';
import { renderBeds } from './views/beds.js';
import { renderAdmit } from './views/admit.js';
import { renderAdmission } from './views/admission.js';
import { renderInpatients } from './views/inpatients.js';
import { renderLogin } from './views/login.js';
import { renderHome } from './views/home.js';
import { renderPatients, renderPatient, openPatientForm } from './views/patients.js';
import { renderVisit } from './views/visit.js';
import { renderOpenVisits } from './views/open.js';
import { renderReceipts } from './views/receipts.js';
import { renderContracts, renderPayerEdit, renderPriceListEdit } from './views/contracts.js';
import { renderCashier, openShiftClose } from './views/cashier.js';
import { renderReports } from './views/reports.js';
import { renderRadiology, renderRadStudy } from './views/radiology.js';
import { renderLab, renderLabGroup } from './views/lab.js';
import { renderAccounts, renderTicket } from './views/accounts.js';
import { renderStores, renderTransfer, renderCount } from './views/stores.js';
import { renderPharmacy } from './views/pharmacy.js';
import { renderClaims, renderClaimReview, renderClaim, renderClaimNotes } from './views/claims.js';
import { renderFinance, renderVouchers, renderManagerDash } from './views/finance.js';
import { renderLedger } from './views/ledger.js';
import { renderPeer, renderPeerWork } from './views/peer.js';
import { renderEta } from './views/eta.js';

const ROUTES = [
  [/^\/?$/, renderHome, 'home'],
  [/^\/patients$/, renderPatients, 'patients'],
  [/^\/patient\/(\d+)$/, renderPatient, 'patients'],
  [/^\/visit\/(\d+)$/, renderVisit, 'patients'],
  [/^\/open$/, renderOpenVisits, 'open'],
  [/^\/receipts$/, renderReceipts, 'receipts'],
  [/^\/settings$/, renderSettings, 'settings'],
  [/^\/beds$/, renderBeds, 'beds'],
  [/^\/admit$/, renderAdmit, 'beds'],
  [/^\/admission\/(\d+)$/, renderAdmission, 'inpatients'],
  [/^\/inpatients$/, renderInpatients, 'inpatients'],
  [/^\/contracts$/, renderContracts, 'contracts'],
  [/^\/payer\/(new|\d+)$/, renderPayerEdit, 'contracts'],
  [/^\/pricelist\/(new|\d+)$/, renderPriceListEdit, 'contracts'],
  [/^\/cashier$/, renderCashier, 'cashier'],
  [/^\/reports$/, renderReports, 'reports'],
  [/^\/radiology$/, renderRadiology, 'radiology'],
  [/^\/rad\/([va]\d+)$/, renderRadStudy, 'radiology'],
  [/^\/lab$/, renderLab, 'lab'],
  [/^\/labg\/(V\d+|A\d+-\d{8})$/, renderLabGroup, 'lab'],
  [/^\/accounts$/, renderAccounts, 'accounts'],
  [/^\/ticket\/(\d+)$/, renderTicket, 'accounts'],
  [/^\/stores$/, renderStores, 'stores'],
  [/^\/transfer\/(\d+)$/, renderTransfer, 'stores'],
  [/^\/count\/(\d+)$/, renderCount, 'stores'],
  [/^\/pharmacy$/, renderPharmacy, 'pharmacy'],
  [/^\/claims$/, renderClaims, 'claims'],
  [/^\/claims\/review$/, renderClaimReview, 'claims'],
  [/^\/claim\/(\d+)$/, renderClaim, 'claims'],
  [/^\/claim-notes$/, renderClaimNotes, 'claimnotes'],
  [/^\/finance$/, renderFinance, 'finance'],
  [/^\/ledger$/, renderLedger, 'ledger'],
  [/^\/peer$/, renderPeer, 'peer'],
  [/^\/peer-work$/, renderPeerWork, 'peer-work'],
  [/^\/eta$/, renderEta, 'eta'],
  [/^\/vouchers$/, renderVouchers, 'vouchers'],
  [/^\/dash$/, renderManagerDash, 'dash'],
];

const app = document.getElementById('app');
const NO_HOME = (me) => (me.home || '/') !== '/';
let cleanup = null;
let openCount = 0;

export function go(path) { location.hash = '#' + path; }
window.go = go;

function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1) || '/');
  const [path, qs] = h.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

function shell() {
  const me = state.me;
  app.innerHTML = String(html`
  <div class="shell">
    <aside class="rail">
      <div class="brand"><img src="${state.brand.logo}" alt=""><div><b>${state.brand.name}</b><small>${state.brand.sub}</small></div></div>
      <nav class="nav" aria-label="القائمة">
        ${NO_HOME(me) ? '' : html`<a href="#/" data-nav="home">${icon('home')}<span>الرئيسية</span></a>`}
        ${can('adm.bill') ? html`<a href="#/accounts" data-nav="accounts">${icon('ticket')}<span>حسابات الإقامة</span><b class="badge hide" id="tkBadge" style="background:var(--warn);color:#fff"></b></a>` : ''}
        ${can('fin.dash') ? html`<a href="#/dash" data-nav="dash">${icon('chart')}<span>الملخص المالي</span></a>` : ''}
        ${can('cash.cashier') ? html`<a href="#/cashier" data-nav="cashier" class="navcash">${icon('cashbox')}<span>الخزينة</span><b class="badge hide" id="ordBadge" style="background:var(--py-2);color:#fff"></b></a>` : ''}
        ${can('fin.voucher') && !can('fin.view') ? html`<a href="#/vouchers" data-nav="vouchers">${icon('cash')}<span>صرف نقدي</span><b class="badge hide" id="vouBadge" style="background:var(--py-2);color:#fff"></b></a>` : ''}
        ${can('pharmacy.sell') ? html`<a href="#/pharmacy" data-nav="pharmacy">${icon('pill')}<span>الصيدلية</span></a>` : ''}
        ${can('stock.view') ? html`<a href="#/stores" data-nav="stores">${icon('box')}<span>المخازن</span><b class="badge hide" id="stBadge" style="background:var(--warn);color:#fff"></b></a>` : ''}
        ${can('visits.read') || can('admissions.read') ? html`<a href="#/patients" data-nav="patients">${icon('users')}<span>المرضى</span></a>` : ''}
        ${!NO_HOME(me) || can('cash.cashier') ? html`<a href="#/open" data-nav="open">${icon('hourglass')}<span>زيارات مفتوحة</span><b class="badge brand hide" id="openBadge"></b></a>` : ''}
        ${can('receipts.read') ? html`<a href="#/receipts" data-nav="receipts">${icon('receipt')}<span>الإيصالات</span></a>` : ''}
        ${can('lab.read') ? html`<a href="#/lab" data-nav="lab">${icon('flask')}<span>المعمل</span><b class="badge hide" id="labBadge" style="background:var(--lab);color:#fff"></b></a>` : ''}
        ${can('rad.read') ? html`<a href="#/radiology" data-nav="radiology">${icon('scan')}<span>الأشعة</span><b class="badge hide" id="radBadge" style="background:var(--radiology);color:#fff"></b></a>` : ''}
        <div class="sep"></div>
        ${can('admissions.read') ? html`<a href="#/beds" data-nav="beds">${icon('layers')}<span>لوحة الأسرّة</span></a>` : ''}
        ${can('admissions.read') ? html`<a href="#/inpatients" data-nav="inpatients">${icon('bed')}<span>المقيمين</span><b class="badge hide" id="inBadge" style="background:rgba(255,255,255,.16);color:#fff"></b></a>` : ''}
        ${can('claims.review') || can('claims.manage') ? html`<a href="#/claims" data-nav="claims">${icon('file')}<span>حسابات التعاقدات</span><b class="badge hide" id="clBadge" style="background:var(--warn);color:#fff"></b></a>`
          : can('claims.fix') ? html`<a href="#/claim-notes" data-nav="claimnotes" id="cnNav" class="hide">${icon('alert')}<span>ملاحظات التعاقدات</span><b class="badge" id="cnBadge" style="background:var(--warn);color:#fff"></b></a>` : ''}
        ${can('ledger.view') ? html`<a href="#/ledger" data-nav="ledger">${icon('file')}<span>الدفاتر</span></a>` : ''}
        ${can('peer.switch') ? html`<a href="#" id="swPeer" hidden>${icon('link')}<span>المنشأة التانية</span></a>` : ''}
        ${can('eta.view') ? html`<a href="#/eta" data-nav="eta">${icon('receipt')}<span>الإيصال الإلكتروني</span></a>` : ''}
        ${can('peer.work') ? html`<a href="#/peer-work" data-nav="peer-work">${icon('link')}<span>طلبات المستشفى</span></a>` : ''}
        ${can('peer.manage') ? html`<a href="#/peer" data-nav="peer">${icon('link')}<span>الربط مع منشأة تانية</span></a>` : ''}
        ${can('fin.view') ? html`<a href="#/finance" data-nav="finance">${icon('wallet')}<span>الحسابات العامة</span><b class="badge hide" id="vouBadge" style="background:var(--py-2);color:#fff"></b></a>` : ''}
        ${can('payers.read') ? html`<a href="#/contracts" data-nav="contracts">${icon('shield')}<span>التعاقدات</span><b class="badge hide" id="apBadge" style="background:var(--warn);color:#fff"></b></a>` : ''}
        ${can('reports.treasury') ? html`<a href="#/reports" data-nav="reports">${icon('chart')}<span>التقارير</span></a>` : ''}
        ${can('shift.close') ? html`<a href="javascript:void 0" id="closeShiftNav">${icon('lock')}<span>تقفيل الوردية</span><b class="badge hide" id="handBadge" style="background:var(--warn);color:#fff"></b></a>` : ''}
        ${can('settings.manage') ? html`<div class="sep"></div><a href="#/settings" data-nav="settings">${icon('settings')}<span>الإعدادات</span></a>` : ''}
      </nav>
      <div class="me"><span class="avatar">${initials(me.name)}</span><div><b>${me.name}</b><small>${me.roleName}</small></div>
        <button id="mypw" title="غيّر كلمة السر" aria-label="غيّر كلمة السر">${icon('key')}</button>
        <button id="logout" title="خروج" aria-label="خروج">${icon('logout')}</button></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <div><h1 id="pageTitle">الرئيسية</h1><div class="crumb" id="crumb">${fmtDay()}</div></div>
        <div class="gsearch">
          ${icon('search')}
          <input id="gs" type="search" autocomplete="off" placeholder="دوّر على مريض: اسم، تليفون، رقم ملف، أو رقم قومي" aria-label="بحث عن مريض">
          <kbd>/</kbd>
        </div>
        <button class="btn ghost icon sm mob-only" id="logout2" title="خروج" aria-label="خروج">${icon('logout')}</button>
${can('cash.collect') ? html`<a class="shiftchip" href="#/receipts" id="shiftChip" title="تحصيل ورديتي"><i></i><span>ورديتي</span><b class="num" id="shiftAmt">0</b></a>` : ''}
      </header>
      <main class="view" id="view"></main>
    </div>
  </div>`);
  $('#logout2').addEventListener('click', () => $('#logout').click());
  $('#logout').addEventListener('click', async () => {
    await api.post('/logout').catch(() => {});
    state.me = null;
    boot();
  });
  $('#mypw').addEventListener('click', changeMyPassword);
  $('#closeShiftNav')?.addEventListener('click', () => openShiftClose({ onDone: () => route() }));
  setupGlobalSearch();
}

function changeMyPassword() {
  const m = modal({
    title: 'غيّر كلمة السر',
    body: html`<div class="grid" style="gap:12px">
      <div class="field" data-f="current"><label>كلمة السر الحالية</label><input class="input" type="password" name="current" autocomplete="current-password" autofocus><div class="msg"></div></div>
      <div class="field" data-f="next"><label>كلمة السر الجديدة <span class="hint">6 حروف على الأقل</span></label><input class="input" type="password" name="next" autocomplete="new-password"><div class="msg"></div></div>
      <div class="field" data-f="again"><label>اكتبها تاني</label><input class="input" type="password" name="again" autocomplete="new-password"><div class="msg"></div></div></div>`,
    foot: html`<button class="btn ghost" data-close>إلغاء</button><button class="btn" data-ok>${icon('check')} احفظ</button>`,
  });
  const v = (n) => $(`[name=${n}]`, m.el).value;
  const err = (f, t) => { const b = $(`[data-f=${f}]`, m.el); b.classList.add('err'); $('.msg', b).textContent = t; };
  const go = async () => {
    m.el.querySelectorAll('.field').forEach((f) => { f.classList.remove('err'); $('.msg', f).textContent = ''; });
    if (v('next') !== v('again')) return err('again', 'مش زي كلمة السر الجديدة');
    try {
      await api.post('/me/password', { current: v('current'), next: v('next') });
      m.close(); toast('اتغيرت كلمة السر');
    } catch (e) {
      if (e instanceof ApiError && e.data.errors) Object.entries(e.data.errors).forEach(([f, t]) => err(f, t));
      else toast(e.message, 'err');
    }
  };
  $('[data-ok]', m.el).addEventListener('click', go);
  m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

export function setTitle(title, crumb) {
  const t = $('#pageTitle');
  if (t) t.textContent = title;
  const c = $('#crumb');
  if (c) c.textContent = crumb || fmtDay();
  document.title = title + ' | ' + state.brand.name;
}

export async function refreshShell() {
  if (can('claims.fix') || can('claims.review')) api.get('/claims/notes/count').then((c) => {
    const b = $('#clBadge') || $('#cnBadge'); if (b) { b.textContent = c.count; b.classList.toggle('hide', !c.count && b.id === 'clBadge'); }
    $('#cnNav')?.classList.toggle('hide', !c.count && location.hash !== '#/claim-notes');
  }).catch(() => {});
  if (can('fin.voucher') || can('fin.view')) api.get('/finance/vouchers/count').then((c) => { const b = $('#vouBadge'); if (b) { b.textContent = c.count; b.classList.toggle('hide', !c.count); } }).catch(() => {});
  if (can('stock.view')) api.get('/stores/counts').then((c) => { const b = $('#stBadge'); if (b) { b.textContent = c.total; b.classList.toggle('hide', !c.total); } }).catch(() => {});
  if (!can('visits.read')) return null;
  try {
    const s = await api.get('/home/summary');
    $('#shiftAmt') && ($('#shiftAmt').textContent = money(s.shift?.net || 0));
    openCount = s.today.openWithDue;
    const b = $('#openBadge');
    if (b) { b.textContent = openCount; b.classList.toggle('hide', !openCount); }
    const ab = $('#apBadge');
    const an = (s.approvals?.pending || 0) + (s.approvals?.tempcash || 0);
    if (ab) { ab.textContent = an; ab.classList.toggle('hide', !an); }
    const rb = $('#radBadge');
    const rn = (s.radiology?.waiting || 0) + (s.radiology?.report || 0);
    if (rb) { rb.textContent = rn; rb.classList.toggle('hide', !rn); rb.style.background = s.radiology?.overdue ? 'var(--danger)' : 'var(--radiology)'; }
    const lb = $('#labBadge');
    const ln = (s.lab?.waiting || 0) + (s.lab?.inlab || 0);
    if (lb) { lb.textContent = ln; lb.classList.toggle('hide', !ln); lb.style.background = s.lab?.overdue ? 'var(--danger)' : 'var(--lab)'; }
    const tb = $('#tkBadge');
    const tn = s.tickets?.noTicketToday || 0;
    if (tb) { tb.textContent = tn; tb.classList.toggle('hide', !tn); }
    const ob = $('#ordBadge');
    if (ob) { ob.textContent = s.orders?.count || 0; ob.classList.toggle('hide', !s.orders?.count); }
    const hb = $('#handBadge');
    if (hb) { hb.textContent = s.handovers || 0; hb.classList.toggle('hide', !s.handovers); }
    const sw = $('#swPeer');
    if (sw && !sw.dataset.ready) {
      sw.dataset.ready = '1';
      api.get('/peer/switch-info').then((i) => {
        if (!i.enabled) return;
        sw.hidden = false; sw.querySelector('span').textContent = 'الانتقال إلى ' + i.name;
        sw.addEventListener('click', async (e) => {
          e.preventDefault();
          const w = window.open('', '_blank');
          try { const r = await api.get('/peer/switch-url'); if (w) w.location = r.url; else location.href = r.url; } catch (er) { w?.close(); toastError(er); }
        });
      }).catch(() => {});
    }
    const sc = $('#shiftChip');
    if (sc) sc.title = s.cashier ? `الخزينة شغالة: ${s.cashier.name}` : 'تحصيل ورديتي';
    const ib = $('#inBadge');
    if (ib) { ib.textContent = s.beds.occupied; ib.classList.toggle('hide', !s.beds.occupied); }
    return s;
  } catch { return null; }
}
window.refreshShell = refreshShell;

async function route() {
  if (!state.me) return;
  const { path, query } = parseHash();
  let match = null;
  for (const [re, fn, nav] of ROUTES) {
    const m = path.match(re);
    if (m) { match = { fn, nav, params: m.slice(1) }; break; }
  }
  if (!match) return go('/');
  if (match.nav === 'home' && NO_HOME(state.me)) return go(state.me.home);
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  $$('.nav a[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === match.nav));
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    cleanup = await match.fn(view, { params: match.params, query, setTitle });
  } catch (e) {
    view.innerHTML = String(html`<div class="card empty"><div class="art">${icon('alert')}</div><b>الصفحة دي ما فتحتش</b>${e.message}</div>`);
  }
}

// ---------- البحث العام ----------
function setupGlobalSearch() {
  const input = $('#gs');
  const box = input.parentElement;
  let pop = null, items = [], idx = -1, last = '';
  const close = () => { pop?.remove(); pop = null; idx = -1; };
  const draw = (q) => {
    close();
    pop = el(html`<div class="gs-pop" role="listbox">
      ${items.length ? items.map((p, i) => html`<a class="gs-item" data-i="${i}" href="#/patient/${p.id}">
          <span class="pavatar ${p.sex || ''}">${initials(p.name)}</span>
          <div><b>${p.name}</b><small><span class="num">#${p.no}</span>${p.phone ? html` · <span class="num">${p.phone}</span>` : ''}${p.age ? ' · ' + p.age : ''}</small></div>
          ${p.due > 0 ? html`<span class="badge warn" style="margin-inline-start:auto">عليه <span class="num">${money(p.due)}</span></span>` : ''}
        </a>`) : html`<div class="empty" style="padding:18px">مفيش نتيجة لـ «${q}»</div>`}
      <div class="gs-foot"><span>↑ ↓ للتنقل · Enter للفتح</span><a href="#/patients?q=${encodeURIComponent(q)}" style="font-weight:800;color:var(--brand)">كل النتايج والتسجيل</a></div>
    </div>`);
    box.append(pop);
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    pop.addEventListener('click', () => { close(); input.value = ''; input.blur(); });
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    last = q;
    try {
      const r = await api.get('/patients/search?q=' + encodeURIComponent(q));
      if (q !== last || document.activeElement !== input) return;
      items = r.results.slice(0, 7);
      draw(q);
    } catch { /* تجاهل */ }
  }, 180);
  input.addEventListener('input', search);
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) search(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    const links = pop ? $$('.gs-item', pop) : [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!links.length) return;
      idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links.forEach((a, i) => a.classList.toggle('on', i === idx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (idx >= 0 && items[idx]) go('/patient/' + items[idx].id);
      else if (items.length === 1) go('/patient/' + items[0].id);
      else go('/patients?q=' + encodeURIComponent(q));
      close(); input.value = ''; input.blur();
    } else if (e.key === 'Escape') { close(); input.blur(); }
  });
}

// ---------- الاختصارات ----------
document.addEventListener('keydown', (e) => {
  if (!state.me || document.querySelector('.overlay')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#gs')?.focus(); }
  if (e.key === 'F2') { e.preventDefault(); openPatientForm({ onSaved: (p) => go('/patient/' + p.id) }); }
  if (e.key === 'F4') { e.preventDefault(); go('/open'); }
  if (e.key === 'F3') { e.preventDefault(); go('/beds'); }
});

window.addEventListener('hashchange', route);
window.addEventListener('auth:lost', () => {
  if (!state.me) return;
  state.me = null;
  toast('الجلسة خلصت. سجّل دخول تاني.', 'warn');
  boot();
});

async function boot() {
  try { applyBrand(await api.get('/branding')); } catch { /* الافتراضي */ }
  try {
    const r = await api.get('/me');
    state.me = r.user;
    state.hospital = r.hospital;
    await refreshLookups();
    shell();
    route();
    refreshShell();
  } catch {
    state.me = null;
    renderLogin(app, async (user) => {
      state.me = user;
      const r = await api.get('/me');
      state.hospital = r.hospital;
      await refreshLookups();
      shell();
      route();
      refreshShell();
      toast(`أهلًا ${user.name.replace(/^د\.\s*/, '').split(' ')[0]}، يوم سعيد`, 'ok');
    });
  }
}
boot();
