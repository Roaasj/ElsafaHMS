import { api, html, icon, $, state } from '../core.js';

export function renderLogin(root, onDone) {
  document.title = 'تسجيل الدخول | ' + state.brand.name;
  root.innerHTML = String(html`
  <div class="login">
    <section class="art">
      <div>
        <img class="logo" src="${state.brand.logo}" alt="">
        <h1>أهلًا بيك في<br>${state.brand.name}</h1>
        <p>استقبال المرضى والخزينة من شاشة واحدة، بسرعة ومن غير لف.</p>
        <div class="feats">
          <div class="feat"><span>${icon('search')}</span>ملف واحد للمريض، ودوّر عليه بأي حاجة تعرفها</div>
          <div class="feat"><span>${icon('sparkle')}</span>الخدمة والدكتور والسعر بييجوا لوحدهم</div>
          <div class="feat"><span>${icon('print')}</span>ادفع واطبع الإيصال في نفس الشاشة</div>
        </div>
      </div>
      <footer>${state.brand.name}${state.brand.footer ? ' · ' + state.brand.footer : ''}</footer>
    </section>
    <section class="form-side">
      <form id="lf" novalidate>
        <h2>تسجيل الدخول</h2>
        <p>ادخل بنفس اسم المستخدم بتاعك</p>
        <div class="field"><label for="u">اسم المستخدم</label><input class="input" id="u" autocomplete="username" autocapitalize="off" spellcheck="false" required></div>
        <div class="field"><label for="p">كلمة السر</label>
          <div class="pw"><input class="input" id="p" type="password" autocomplete="current-password" required><button type="button" id="showpw">إظهار</button></div></div>
        <div id="err" class="error hide" role="alert"></div>
        <button class="btn lg block" id="go" type="submit">دخول</button>
        <div class="clock" id="clk"></div>
      </form>
    </section>
  </div>`);
  const u = $('#u'), p = $('#p'), err = $('#err'), btn = $('#go'), form = $('#lf');
  const last = localStorage.getItem('lastUser');
  if (last) { u.value = last; setTimeout(() => p.focus(), 50); } else setTimeout(() => u.focus(), 50);
  $('#showpw').addEventListener('click', (e) => {
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    e.target.textContent = show ? 'إخفاء' : 'إظهار';
    p.focus();
  });
  const tick = () => {
    const c = $('#clk');
    if (!c) return clearInterval(t);
    c.textContent = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: HMS.tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date());
  };
  const t = setInterval(tick, 20000); tick();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hide');
    if (!u.value.trim() || !p.value) { err.innerHTML = String(html`${icon('info')}<span>اكتب اسم المستخدم وكلمة السر</span>`); err.classList.remove('hide'); return; }
    btn.disabled = true; btn.textContent = 'لحظة...';
    try {
      const r = await api.post('/login', { username: u.value.trim(), password: p.value });
      localStorage.setItem('lastUser', u.value.trim());
      clearInterval(t);
      onDone(r.user);
    } catch (ex) {
      err.innerHTML = String(html`${icon('alert')}<span>${ex.message}</span>`);
      err.classList.remove('hide');
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      p.select();
    } finally { btn.disabled = false; btn.textContent = 'دخول'; }
  });
}
