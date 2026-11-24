// نظام إدارة المستشفى - السيرفر
import express from 'express';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig, ROOT } from './config.js';
import { createDb } from './db/index.js';
import { router } from './lib/router.js';
import { HttpError } from './lib/util.js';
import {
  COOKIE, ROLES, ROLE_HOME, PERMISSIONS, seedRoles, ensureDefaultRoles, loadRoles, createSession, destroySession, userFromToken, verifyPassword, checkLoginRate,
  hashPassword, destroyUserSessions, audit, permsOf, parseList, GRANTS,
} from './lib/auth.js';
import adminRouter from './routes/admin.js';
import admissionsRouter, { postAllNights } from './routes/admissions.js';
import payersRouter, { approvalsRouter } from './routes/payers.js';
import { ordersRouter, shiftsRouter, reportsRouter } from './routes/cashier.js';
import radiologyRouter from './routes/radiology.js';
import labRouter from './routes/lab.js';
import ticketsRouter from './routes/tickets.js';
import { seedLabTests } from './lib/lab-tests.js';
import { seedRadTemplates } from './lib/rad-templates.js';
import { seedStores } from './lib/stock.js';
import { seedClinics } from './lib/clinics.js';
import { seedUnits } from './lib/units.js';
import storesRouter from './routes/stores.js';
import stockReportsRouter from './routes/stock-reports.js';
import claimsRouter from './routes/claims.js';
import financeRouter from './routes/finance.js';
import etaRouter from './routes/eta.js';
import { etaCfg, sweep as etaSweep, refreshIncomplete, submitReady } from './lib/eta.js';
import peerRouter, { peerInbound, peerSso } from './routes/peer.js';
import { flushOutbox } from './lib/peer.js';
import ledgerRouter from './routes/ledger.js';
import { ensureLedger } from './lib/ledger.js';
import patientsRouter from './routes/patients.js';
import catalogRouter from './routes/catalog.js';
import visitsRouter, { receiptsRouter, sweepVisits } from './routes/visits.js';
import printRouter from './routes/print.js';
import homeRouter from './routes/home.js';
import { MODULES, moduleOfApi } from '../shared/modules.js';
import configRouter, { publicBrand, brandDir } from './routes/config.js';
import { loadRuntime, R } from './lib/runtime.js';
import lookupsAdmin, { lookupsPublic } from './routes/lookups.js';
import { loadLookups } from './lib/lookups.js';

function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function buildApp(config, db) {
  await loadRuntime(db);
  await loadLookups(db);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // ملف الإكسل بييجي raw، ولازم قبل express.json
  app.use('/api/admin/services/import', express.raw({ type: () => true, limit: '8mb' }));
  app.use(/^\/api\/approvals\/\d+\/image$/, express.raw({ type: () => true, limit: '8mb' }));
  app.use(/^\/api\/claims\/cases\/\d+\/files$/, express.raw({ type: () => true, limit: '12mb' }));
  app.use(/^\/api\/radiology\/[va]\d+\/file$/, express.raw({ type: () => true, limit: '21mb' }));
  app.use(/^\/api\/lab\/w\/[va]\d+\/file$/, express.raw({ type: () => true, limit: '21mb' }));
  app.use('/api/admin/floor-prices/import', express.raw({ type: () => true, limit: '8mb' }));
  app.use('/api/payers/prices-import', express.raw({ type: () => true, limit: '8mb' }));
  app.use('/api/tickets/items/import', express.raw({ type: () => true, limit: '8mb' }));
  app.use('/api/config/logo', express.raw({ type: () => true, limit: '2mb' }));
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // الملفات الثابتة
  app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: '1h' }));
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0, etag: true, index: false })); // بدون كاش طويل: عشان تحديثات الواجهة تظهر فوراً

  // تحميل المستخدم من الجلسة
  app.use(async (req, res, next) => {
    try {
      req.token = readCookie(req, config.cookieName || COOKIE);
      req.user = await userFromToken(db, req.token);
      next();
    } catch (e) { next(e); }
  });

  const api = router();
  const pub = publicBrand(config);
  app.use('/brand', pub);
  api.use(pub);
  api.post('/login', async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const rate = checkLoginRate(req.ip + '|' + username);
    const u = username && await db.one('SELECT * FROM Users WHERE Username = ?', [username]);
    const ok = u && (u.Active === true || u.Active === 1) && await verifyPassword(password, u.PasswordHash);
    if (!ok) { rate.fail(); throw new HttpError(401, 'اسم المستخدم أو كلمة السر غلط'); }
    rate.ok();
    const token = await createSession(db, u.Id, config.sessionHours);
    await db.run('UPDATE Users SET LastLoginAt = ? WHERE Id = ?', [new Date(), u.Id]);
    res.cookie(config.cookieName || COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionHours * 3600e3, path: '/',
    });
    const gr = parseList(u.Grants).filter((g) => PERM_LABELS[g]); const dn = parseList(u.Denied).filter((g) => PERM_LABELS[g]);
    res.json({ user: { id: u.Id, name: u.FullName, role: u.Role, roleName: ROLES[u.Role], home: ROLE_HOME[u.Role] || '/', permissions: permsOf({ role: u.Role, grants: gr, denied: dn }), grants: gr, denied: dn, stores: parseList(u.StoreIds) } });
  });
  api.post('/logout', async (req, res) => {
    await destroySession(db, req.token);
    res.clearCookie(config.cookieName || COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  // أي حاجة بعد كده محتاجة دخول
  api.use((req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'سجّل دخول الأول'));
    next();
  });
  api.get('/me', (req, res) => {
    res.json({ user: { ...req.user, roleName: ROLES[req.user.role], home: ROLE_HOME[req.user.role] || '/', permissions: permsOf(req.user) }, hospital: R.brand.name });
  });
  api.post('/me/password', async (req, res) => {
    const { current, next: nw } = req.body || {};
    const u = await db.one('SELECT PasswordHash FROM Users WHERE Id = ?', [req.user.id]);
    if (!(await verifyPassword(String(current || ''), u.PasswordHash))) throw new HttpError(400, 'كلمة السر الحالية غلط', { errors: { current: 'كلمة السر الحالية غلط' } });
    if (String(nw || '').length < 6) throw new HttpError(400, 'كلمة السر الجديدة 6 حروف على الأقل', { errors: { next: 'كلمة السر الجديدة 6 حروف على الأقل' } });
    const hash = await hashPassword(nw);
    await db.tx(async (t) => {
      await t.run('UPDATE Users SET PasswordHash = ? WHERE Id = ?', [hash, req.user.id]);
      await destroyUserSessions(t, req.user.id, req.token);
      await audit(t, req.user, 'user.password', 'User', req.user.id, { note: 'غيّر كلمة السر بنفسه' });
    });
    res.json({ ok: true });
  });
  api.use((req, res, next) => { // قسم موقوف من الإعدادات: الـ API بتاعه بيرفض
    const m = moduleOfApi(req.path);
    if (m && R.modules[m] === false) return next(new HttpError(403, `قسم «${MODULES[m].name}» موقوف من الإعدادات`));
    next();
  });
  api.use('/config/lookups', lookupsAdmin(db));
  api.use('/config', configRouter(db, config));
  api.use(lookupsPublic());
  api.use('/home', homeRouter(db));
  api.use('/admin', adminRouter(db));
  api.use('/admissions', admissionsRouter(db));
  api.use('/payers', payersRouter(db));
  api.use('/approvals', approvalsRouter(db));
  api.use('/patients', patientsRouter(db));
  api.use('/catalog', catalogRouter(db));
  api.use('/visits', visitsRouter(db));
  api.use('/receipts', receiptsRouter(db));
  api.use('/orders', ordersRouter(db));
  api.use('/shifts', shiftsRouter(db));
  api.use('/reports', reportsRouter(db));
  api.use('/radiology', radiologyRouter(db));
  api.use('/lab', labRouter(db));
  api.use('/tickets', ticketsRouter(db));
  api.use('/stock-reports', stockReportsRouter(db));
  api.use('/claims', claimsRouter(db));
  api.use('/finance', financeRouter(db));
  api.use('/ledger', ledgerRouter(db));
  api.use('/peer', peerRouter(db));
  api.use('/eta', etaRouter(db));
  api.use('/stores', storesRouter(db));
  api.use((req, res, next) => next(new HttpError(404, 'مش موجود')));
  app.get('/peer-sso', peerSso(db, config));
  app.use('/peer', peerInbound(db)); // المنشأة التانية (بمفتاح الربط، مش بجلسة)
  app.use('/api', api);

  const print = router();
  print.use((req, res, next) => (req.user ? next() : res.redirect('/')));
  // تذييل الطباعة من إعدادات الهوية، بيتحط في كل ورقة قبل نهاية الصفحة
  print.use((req, res, next) => {
    const send = res.send.bind(res);
    res.send = (body) => {
      if (typeof body === 'string' && R.brand.footer) {
        const f = R.brand.footer.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        body = body.replace('</body>', `<div style="text-align:center;font-size:11px;color:#6b5a54;margin:10px auto 0;max-width:720px;padding-top:6px;border-top:1px dashed #ddd">${f}</div></body>`);
      }
      return send(body);
    };
    next();
  });
  app.use('/print', print, printRouter(db, config));

  // الواجهة (صفحة واحدة)
  app.get(['/', '/app', '/app/*'], (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  // معالج الأخطاء
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'البيانات مش مفهومة' });
    console.error(new Date().toISOString(), req.method, req.originalUrl, err);
    res.status(500).json({ error: 'حصلت مشكلة في السيرفر. لو اتكررت بلّغ الدعم الفني.' });
  });
  return app;
}

function checkNode() {
  const [maj, min, pat] = process.versions.node.split('.').map(Number);
  const v = maj * 1e6 + min * 1e3 + pat;
  // أقل نسخ فيها تصحيحات أمان أكتوبر 2026
  const okv = { 22: 22023004, 24: 24022001, 26: 26012001 }[maj];
  if (maj < 22 || (okv && v < okv) || (maj % 2 === 1)) {
    console.warn(`\n  تنبيه: نسخة Node.js ${process.versions.node} قديمة أو مش LTS. نزّل آخر نسخة LTS من nodejs.org (فيها تصحيحات أمان).\n`);
  }
}

export async function start(overrides = {}) {
  checkNode();
  const config = loadConfig(overrides);
  if (config.db.driver === 'sqlite' && config.db.sqlite.file !== ':memory:') {
    mkdirSync(path.dirname(config.db.sqlite.file), { recursive: true });
  }
  const db = await createDb(config.db);
  await seedRadTemplates(db).catch((e) => console.error('قوالب الأشعة', e.message));
  await seedLabTests(db).catch((e) => console.error('تحاليل المعمل', e.message));
  await seedStores(db).catch((e) => console.error('المخازن', e.message));
  await seedClinics(db).catch((e) => console.error('العيادات', e.message));
  await seedUnits(db).catch((e) => console.error('الوحدات', e.message));
  await seedRoles(db).catch((e) => console.error('الأدوار', e.message));
  await ensureLedger(db).catch((e) => console.error('دليل الحسابات', e.message));
  await ensureDefaultRoles(db).catch((e) => console.error('الأدوار الجديدة', e.message));
  await loadRoles(db).catch((e) => console.error('تحميل الأدوار', e.message));
  const app = await buildApp(config, db);
  const server = await new Promise((resolve) => {
    const s = app.listen(config.port, () => resolve(s));
  });
  const timer = setInterval(() => {
    sweepVisits(db).catch((e) => console.error('sweep', e));
    postAllNights(db).catch((e) => console.error('nights', e));
  }, 3600e3);
  timer.unref();
  const peerTimer = setInterval(() => flushOutbox(db).catch(() => {}), 60e3); // إعادة محاولة تعديلات المربوطين
  peerTimer.unref();
  const etaTimer = setInterval(async () => { try { const c = await etaCfg(db); if (c.enabled && c.mode === 'auto') { await etaSweep(db, c); await refreshIncomplete(db, c); await submitReady(db, c); } } catch { /* بيتعاد بعد دقيقة */ } }, 60e3);
  etaTimer.unref();
  server.on('close', () => { clearInterval(timer); clearInterval(peerTimer); clearInterval(etaTimer); });
  return { app, db, server, config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'src', 'server.js')) {
  start().then(({ config, server }) => {
    const port = server.address().port;
    console.log(`\n  ${R.brand.name} · النظام شغال على  http://localhost:${port}`);
    console.log(`  قاعدة البيانات: ${config.db.driver === 'mssql' ? 'SQL Server / ' + config.db.mssql.database : 'SQLite تجريبي'}\n`);
  }).catch((e) => {
    console.error('السيرفر ما اشتغلش:', e.message);
    process.exit(1);
  });
}
