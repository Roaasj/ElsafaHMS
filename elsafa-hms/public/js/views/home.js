import { firstDept, state, api, html, icon, $, money, egp, fmtTime, ago, DEPT, DEPT_KEYS, printReceipt } from '../core.js';
import { openPatientForm } from './patients.js';

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: HMS.tz, hour: 'numeric', hour12: false }).format(new Date()));
  if (h >= 5 && h < 12) return { t: 'صباح الخير', ic: 'sun', night: false };
  if (h >= 12 && h < 18) return { t: 'مساء الخير', ic: 'sun', night: false };
  return { t: 'مساء النور', ic: 'moon', night: true };
}

export async function renderHome(view, { setTitle }) {
  setTitle('الرئيسية');
  const g = greeting();
  const first = state.me.name.replace(/^د\.\s*/, '').split(' ')[0];
  view.innerHTML = String(html`
    <div class="grid" style="gap:18px">
      <section class="hello">
        <div class="sunny ${g.night ? 'night' : ''}">${icon(g.ic, 'lg')}</div>
        <div style="position:relative;z-index:1"><h2>${g.t} يا ${first}</h2><p id="shiftLine">جاري تحميل ورديتك...</p></div>
        <div class="stat"><small>تحصيل ورديتي</small><b class="num" id="myNet">—</b> <span>${HMS.money.unitWord}</span></div>
      </section>

      <section class="actions">
        <a class="action" href="#/patients" style="--ac:var(--brand)"><span class="ic">${icon('search', 'lg')}</span><div><b>زيارة جديدة</b></div><small>دوّر على المريض وافتح له زيارة</small><kbd class="kbd">/</kbd></a>
        <button class="action" id="newP" style="--ac:#d0661c"><span class="ic">${icon('user-plus', 'lg')}</span><div><b>مريض جديد</b></div><small>افتح ملف جديد في ثواني</small><kbd class="kbd">F2</kbd></button>
        <button class="action" id="quickEr" style="--ac:var(--emergency)"><span class="ic">${icon('bolt', 'lg')}</span><div><b>طوارئ سريع</b></div><small>افتح الزيارة بالاسم بس وكمّل بعدين</small></button>
        <a class="action" href="#/beds" style="--ac:#7a3fb8"><span class="ic">${icon('bed', 'lg')}</span><div><b>دخول وأسرّة</b></div><small id="bedLine">لوحة الأسرّة والدخول الجديد</small><kbd class="kbd">F3</kbd></a>
      </section>

      <section class="stats" id="stats">
        ${DEPT_KEYS.map((k) => html`<div class="card stat-card d-${k}"><span class="dicon">${icon(DEPT[k].icon)}</span><div><b class="num" data-t="${k}">—</b><small>${DEPT[k].name} النهارده</small></div></div>`)}
      </section>

      <section class="home-cols">
        <div class="card pad">
          <h3>${icon('receipt')} آخر إيصالاتي <a href="#/receipts" class="linkbtn" style="margin-inline-start:auto">كل الإيصالات ${icon('chev-left', 'sm')}</a></h3>
          <div class="list" id="recent"><div class="skel" style="height:120px"></div></div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="card pad">
            <h3>${icon('sparkle')} النهارده في المستشفى</h3>
            <div class="list" id="todayList"></div>
          </div>
          <div class="card pad">
            <h3>${icon('layers')} الأسرّة دلوقتي <a href="#/beds" class="linkbtn" style="margin-inline-start:auto">اللوحة ${icon('chev-left', 'sm')}</a></h3>
            <div id="bedsMini"></div>
            <div class="soon-grid" style="margin-top:12px">
              <a class="soon-tile ap-tile" href="#/contracts" style="text-decoration:none">${icon('shield')}موافقات مستنية المراجعة <b class="num" id="apN" style="margin-inline-start:auto"></b></a>
              <div class="soon-tile">${icon('wallet')}تقفيل الوردية والتقارير · قريبًا</div>
              <a class="soon-tile" href="#/open" style="text-decoration:none">${icon('hourglass')}زيارات مفتوحة <b class="num" id="openN2" style="margin-inline-start:auto"></b></a>
            </div>
          </div>
        </div>
      </section>
    </div>`);

  $('#newP').addEventListener('click', () => openPatientForm({ onSaved: (p) => go('/patient/' + p.id) }));
  $('#quickEr').addEventListener('click', () => openPatientForm({ quick: true, onSaved: async (p) => {
    const v = await api.post('/visits', { patientId: p.id, type: firstDept('emergency') });
    go('/visit/' + v.visit.id);
  } }));

  const s = await window.refreshShell();
  if (!s || !document.body.contains(view)) return;
  $('#shiftLine').textContent = s.shift
    ? `ورديتك مفتوحة من ${fmtTime(s.shift.openedAt)} · ${s.shift.count} إيصال`
    : 'ورديتك هتتفتح لوحدها مع أول إيصال';
  $('#myNet').textContent = money(s.shift?.net || 0);
  for (const k of DEPT_KEYS) $(`[data-t="${k}"]`).textContent = s.today.byType[k] || 0;
  $('#openN2').textContent = s.today.openWithDue || '';
  const apn = (s.approvals?.pending || 0) + (s.approvals?.tempcash || 0);
  $('#apN').textContent = apn || '';
  $('.ap-tile').classList.toggle('hot', apn > 0);
  const bs = s.beds;
  $('#bedLine').textContent = bs.total ? `${bs.free} فاضي من ${bs.total} · ${bs.occupied} مريض داخل` : 'لسه مفيش غرف متسجلة';
  const pc = (n) => (bs.total ? (n / bs.total) * 100 : 0);
  $('#bedsMini').innerHTML = bs.total ? String(html`<div class="occbar"><i class="st-occupied" style="width:${pc(bs.occupied)}%"></i><i class="st-reserved" style="width:${pc(bs.reserved)}%"></i><i class="st-cleaning" style="width:${pc(bs.cleaning)}%"></i><i class="st-free" style="width:${pc(bs.free)}%"></i></div>
    <div class="bb-legend" style="margin-top:8px"><span class="lg st-occupied"><i></i>مشغول <b class="num">${bs.occupied}</b></span><span class="lg st-free"><i></i>فاضي <b class="num">${bs.free}</b></span><span class="lg st-cleaning"><i></i>تنظيف <b class="num">${bs.cleaning}</b></span><span class="lg st-reserved"><i></i>محجوز <b class="num">${bs.reserved}</b></span></div>
    <div class="muted" style="font-size:12.5px;font-weight:700;margin-top:6px">النهارده: ${s.today.admitted} دخول · ${s.today.discharged} خروج</div>`) : String(html`<div class="muted" style="font-weight:600">المدير يضيف الغرف من الإعدادات</div>`);
  $('#recent').innerHTML = s.recent.length ? String(html`${s.recent.map((r) => html`
    <div class="li">
      <span class="badge ${r.net < 0 ? 'danger' : 'ok'}">${{ refund: 'إلغاء', return: 'مرتجع', deposit: 'تأمين', final: 'خروج' }[r.kind] || 'إيصال'} <span class="num">${r.no}</span></span>
      <div><b>${r.patient}</b><small>${ago(r.at)}</small></div>
      <span class="amt">${egp(r.net)}</span>
      <button class="btn ghost icon sm" data-print="${r.id}" title="طباعة نسخة">${icon('print', 'sm')}</button>
    </div>`)}`) : String(html`<div class="empty"><div class="art">${icon('receipt')}</div><b>لسه مفيش إيصالات</b>أول ما تقبض هتلاقيها هنا</div>`);
  $('#recent').addEventListener('click', (e) => { const b = e.target.closest('[data-print]'); if (b) printReceipt(b.dataset.print, false); });
  $('#todayList').innerHTML = String(html`
    <div class="li"><span class="dicon" style="--dc:var(--brand);width:36px;height:36px;border-radius:11px">${icon('clipboard', 'sm')}</span><div><b class="num">${s.today.visits}</b><small>زيارة خارجية</small></div></div>
    <div class="li"><span class="dicon" style="--dc:#d0661c;width:36px;height:36px;border-radius:11px">${icon('user-plus', 'sm')}</span><div><b class="num">${s.today.newPatients}</b><small>ملف جديد</small></div></div>
    <div class="li"><span class="dicon" style="--dc:var(--warn);width:36px;height:36px;border-radius:11px">${icon('hourglass', 'sm')}</span><div><b class="num">${s.today.openWithDue}</b><small>زيارة لسه عليها حساب</small></div></div>`);
}
