// الدفاتر: دليل الحسابات، القيود اليومية (تلقائية ويدوية)، ميزان المراجعة، كشف الحساب، وإعدادات الربط والقفل
import { router } from '../lib/router.js';
import { need, can, audit } from '../lib/auth.js';
import { bad, conflict, notFound, intId, str, cents, pounds, parseMoney } from '../lib/util.js';
import { toIso, toDateStr, toBool } from '../db/index.js';
import { TYPES, MAP_KEYS, SOURCES, balanceOf, post, reverse, ledgerOn, lockDate } from '../lib/ledger.js';
import { businessDate } from '../lib/cashier.js';
import { postShift, pendingShifts } from '../lib/ledger-shift.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const acctDto = (a) => ({ id: a.Id, code: a.Code, name: a.Name, type: a.Type, typeName: TYPES[a.Type], parentId: a.ParentId, isGroup: toBool(a.IsGroup), active: toBool(a.Active), order: a.SortOrder });
const entryDto = (e, lines) => ({
  id: e.Id, no: e.EntryNo, date: toDateStr(e.EntryDate), source: e.Source, sourceName: SOURCES[e.Source] || e.Source, sourceId: e.SourceId, description: e.Description,
  status: e.Status, reversalOf: e.ReversalOf, at: toIso(e.CreatedAt), by: e.ByName || null,
  debit: e.Dr === undefined ? undefined : Number(e.Dr),
  ...(lines ? { lines: lines.map((l) => ({ id: l.Id, accountId: l.AccountId, code: l.Code, account: l.AccountName, debit: Number(l.Debit), credit: Number(l.Credit), memo: l.Memo })) } : {}),
});
const dateOr = (v, def) => (DATE_RE.test(String(v || '')) ? String(v) : def);

export default function ledgerRouter(db) {
  const r = router();
  r.use((req, res, next) => { if (!req.user) return res.status(401).json({ error: 'سجّل دخول الأول' }); next(); });
  const view = (req) => need(req.user, 'ledger.view');

  // ======== دليل الحسابات ========
  r.get('/accounts', async (req, res) => {
    view(req);
    const rows = await db.query('SELECT * FROM Accounts ORDER BY Code');
    const used = new Set((await db.query('SELECT DISTINCT AccountId FROM JournalLines')).map((x) => x.AccountId));
    const mapped = new Set((await db.query('SELECT AccountId FROM AccountMap')).map((x) => x.AccountId));
    res.json({ accounts: rows.map((a) => ({ ...acctDto(a), used: used.has(a.Id), mapped: mapped.has(a.Id) })), types: TYPES });
  });
  const clean = async (t, b, cur) => {
    const code = str(b.code, 20), name = str(b.name, 120);
    if (!code) throw bad('اكتب كود الحساب');
    if (!name) throw bad('اكتب اسم الحساب');
    const dup = await t.one('SELECT Id FROM Accounts WHERE Code = ? AND Id <> ?', [code, cur?.Id || 0]);
    if (dup) throw bad('الكود ده مستخدم في حساب تاني');
    let parentId = b.parentId ? intId(b.parentId, 'الحساب الأب') : null;
    let type = b.type;
    if (parentId) {
      const par = await t.one('SELECT * FROM Accounts WHERE Id = ?', [parentId]);
      if (!par) throw bad('الحساب الأب مش موجود');
      if (!toBool(par.IsGroup)) throw bad('الحساب الأب لازم يكون تجميعي');
      if (cur && parentId === cur.Id) throw bad('الحساب مينفعش يبقى أب لنفسه');
      type = par.Type;
    }
    if (!TYPES[type]) throw bad('اختار نوع الحساب');
    return { Code: code, Name: name, Type: type, ParentId: parentId, IsGroup: b.isGroup ? 1 : 0 };
  };
  r.post('/accounts', async (req, res) => {
    need(req.user, 'ledger.manage');
    const id = await db.tx(async (t) => {
      const v = await clean(t, req.body || {}, null);
      const max = Number((await t.one('SELECT MAX(SortOrder) AS M FROM Accounts'))?.M) || 0;
      const id = await t.insert('Accounts', { ...v, Active: 1, SortOrder: max + 1 });
      await audit(t, req.user, 'account.create', 'Account', id, { now: { code: v.Code, name: v.Name, type: v.Type } });
      return id;
    });
    res.status(201).json({ account: acctDto(await db.one('SELECT * FROM Accounts WHERE Id = ?', [id])) });
  });
  r.put('/accounts/:id', async (req, res) => {
    need(req.user, 'ledger.manage');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const cur = await t.one('SELECT * FROM Accounts WHERE Id = ?', [id]);
      if (!cur) throw notFound('الحساب مش موجود');
      const b = req.body || {};
      const hasLines = !!(await t.one('SELECT Id FROM JournalLines WHERE AccountId = ?', [id]));
      const hasKids = !!(await t.one('SELECT Id FROM Accounts WHERE ParentId = ?', [id]));
      const v = await clean(t, { ...b, code: b.code ?? cur.Code, name: b.name ?? cur.Name, isGroup: b.isGroup ?? toBool(cur.IsGroup), type: b.type ?? cur.Type, parentId: b.parentId === undefined ? cur.ParentId : b.parentId }, cur);
      if ((v.Type !== cur.Type || v.ParentId !== cur.ParentId) && hasLines && v.Type !== cur.Type) throw conflict('الحساب عليه قيود. مينفعش يتغيّر نوعه');
      if (v.IsGroup !== (toBool(cur.IsGroup) ? 1 : 0) && (hasLines || hasKids)) throw conflict('الحساب عليه قيود أو حسابات فرعية. مينفعش يتحول بين تجميعي وفرعي');
      const active = b.active === undefined ? toBool(cur.Active) : !!b.active;
      if (!active && (hasKids && (await t.one('SELECT Id FROM Accounts WHERE ParentId = ? AND Active = 1', [id])))) throw conflict('وقّف الحسابات الفرعية الأول');
      if (!active && (await t.one('SELECT AccountId FROM AccountMap WHERE AccountId = ?', [id]))) throw conflict('الحساب ده متربط بعملية في إعدادات الدفاتر. اربط حساب تاني الأول');
      await t.run('UPDATE Accounts SET Code = ?, Name = ?, Type = ?, ParentId = ?, IsGroup = ?, Active = ? WHERE Id = ?', [v.Code, v.Name, v.Type, v.ParentId, v.IsGroup, active ? 1 : 0, id]);
      await audit(t, req.user, 'account.update', 'Account', id, { old: { code: cur.Code, name: cur.Name, active: toBool(cur.Active) }, now: { code: v.Code, name: v.Name, active } });
    });
    res.json({ account: acctDto(await db.one('SELECT * FROM Accounts WHERE Id = ?', [id])) });
  });
  r.delete('/accounts/:id', async (req, res) => {
    need(req.user, 'ledger.manage');
    const id = intId(req.params.id);
    await db.tx(async (t) => {
      const cur = await t.one('SELECT * FROM Accounts WHERE Id = ?', [id]);
      if (!cur) throw notFound('الحساب مش موجود');
      if (await t.one('SELECT Id FROM JournalLines WHERE AccountId = ?', [id])) throw conflict('الحساب عليه قيود. وقّفه بدل ما تمسحه');
      if (await t.one('SELECT Id FROM Accounts WHERE ParentId = ?', [id])) throw conflict('الحساب فيه حسابات فرعية');
      if (await t.one('SELECT AccountId FROM AccountMap WHERE AccountId = ?', [id])) throw conflict('الحساب متربط بعملية في إعدادات الدفاتر');
      await t.run('DELETE FROM Accounts WHERE Id = ?', [id]);
      await audit(t, req.user, 'account.delete', 'Account', id, { old: { code: cur.Code, name: cur.Name } });
    });
    res.json({ ok: true });
  });

  // ======== إعدادات الربط والقفل ========
  r.get('/settings', async (req, res) => {
    view(req);
    const map = Object.fromEntries((await db.query('SELECT [Key], AccountId FROM AccountMap')).map((x) => [x.Key, x.AccountId]));
    const dyn = [];
    for (const c of await db.query('SELECT Id, Name FROM Clinics WHERE Active = 1 ORDER BY SortOrder, Id')) { dyn.push({ key: `revenue.clinic.${c.Id}`, name: `إيراد عيادة ${c.Name}`, type: 'revenue', dynamic: true }); dyn.push({ key: `doctor.expense.clinic.${c.Id}`, name: `أتعاب أطباء عيادة ${c.Name}`, type: 'expense', dynamic: true }); }
    for (const c of await db.query('SELECT Id, Name FROM ExpenseCategories WHERE Active = 1 ORDER BY SortOrder, Id')) dyn.push({ key: `expense.cat.${c.Id}`, name: `مصروف: ${c.Name}`, type: 'expense', dynamic: true });
    res.json({ enabled: await ledgerOn(db), lockDate: await lockDate(db), map: [...Object.entries(MAP_KEYS).map(([key, m]) => ({ key, name: m.name, type: m.type, accountId: map[key] || null })), ...dyn.map((m) => ({ ...m, accountId: map[m.key] || null }))], canManage: can(req.user, 'ledger.manage') });
  });
  r.put('/settings', async (req, res) => {
    need(req.user, 'ledger.manage');
    const b = req.body || {};
    await db.tx(async (t) => {
      const setKV = async (k, v, note) => {
        const ex = await t.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [k]);
        if (ex?.Value === v) return;
        if (ex) await t.run('UPDATE AppSettings SET Value = ?, UpdatedAt = ?, UpdatedBy = ? WHERE [Key] = ?', [v, new Date(), req.user.id, k]);
        else await t.insert('AppSettings', { '[Key]': k, Value: v, UpdatedAt: new Date(), UpdatedBy: req.user.id });
        await audit(t, req.user, 'settings.update', 'Settings', null, { old: ex?.Value, now: v, note });
      };
      if (b.enabled !== undefined) await setKV('ledgerEnabled', b.enabled ? 'on' : 'off', 'تفعيل القيود المحاسبية');
      if (b.lockDate !== undefined) {
        const d = String(b.lockDate || '');
        if (d && !DATE_RE.test(d)) throw bad('تاريخ القفل مش صحيح');
        await setKV('ledgerLockDate', d, 'قفل الدفاتر لحد تاريخ');
      }
      if (b.map && typeof b.map === 'object') {
        for (const [key, accountId] of Object.entries(b.map)) {
          const dm = /^(revenue\.clinic|doctor\.expense\.clinic|expense\.cat)\.(\d+)$/.exec(key);
          let label = MAP_KEYS[key]?.name;
          if (dm) {
            if (!(await t.one(dm[1] !== 'expense.cat' ? 'SELECT Id FROM Clinics WHERE Id = ?' : 'SELECT Id FROM ExpenseCategories WHERE Id = ?', [Number(dm[2])]))) throw bad('العيادة أو البند مش موجود');
            label = key;
            if (!accountId) { await t.run('DELETE FROM AccountMap WHERE [Key] = ?', [key]); continue; } // الفصل: يرجع للإجمالي
          } else if (!MAP_KEYS[key]) throw bad('عملية غير معروفة');
          const a = await t.one('SELECT * FROM Accounts WHERE Id = ?', [intId(accountId, 'الحساب')]);
          if (!a) throw bad('الحساب مش موجود');
          if (toBool(a.IsGroup) || !toBool(a.Active)) throw bad(`«${a.Name}» تجميعي أو موقوف`);
          const ex = await t.one('SELECT AccountId FROM AccountMap WHERE [Key] = ?', [key]);
          if (ex?.AccountId === a.Id) continue;
          if (ex) await t.run('UPDATE AccountMap SET AccountId = ? WHERE [Key] = ?', [a.Id, key]);
          else await t.insert('AccountMap', { '[Key]': key, AccountId: a.Id });
          await audit(t, req.user, 'ledger.map', 'AccountMap', null, { old: ex?.AccountId, now: a.Id, note: label });
        }
      }
    });
    res.json({ ok: true });
  });

  // ======== ترحيل الورديات المقفولة ========
  r.get('/shifts/pending', async (req, res) => { view(req); res.json({ count: (await pendingShifts(db, dateOr(req.query.from, ''))).length }); });
  r.post('/shifts/post', async (req, res) => {
    need(req.user, 'ledger.post');
    const ids = await pendingShifts(db, dateOr(req.body?.from, ''));
    let done = 0, skipped = 0;
    for (const id of ids) {
      try { await db.tx(async (t) => { if (await postShift(t, req.user, id)) done++; else skipped++; }); } catch (e) { if (e?.status && e.status < 500) { if (done + skipped === 0) throw e; skipped++; } else throw e; }
    }
    res.json({ posted: done, skipped });
  });
  const ENTRY_SQL = `SELECT e.*, u.FullName AS ByName, (SELECT SUM(l.Debit) FROM JournalLines l WHERE l.EntryId = e.Id) AS Dr FROM JournalEntries e JOIN Users u ON u.Id = e.CreatedBy`;
  r.get('/entries', async (req, res) => {
    view(req);
    const where = [], params = [];
    const from = dateOr(req.query.from, null), to = dateOr(req.query.to, null);
    if (from) { where.push('e.EntryDate >= ?'); params.push(from); }
    if (to) { where.push('e.EntryDate <= ?'); params.push(to); }
    if (SOURCES[req.query.source]) { where.push('e.Source = ?'); params.push(req.query.source); }
    if (Number(req.query.accountId)) { where.push('e.Id IN (SELECT EntryId FROM JournalLines WHERE AccountId = ?)'); params.push(Number(req.query.accountId)); }
    const q = str(req.query.q, 60);
    if (q) { where.push('(e.Description LIKE ? OR CAST(e.EntryNo AS NVARCHAR(12)) = ?)'); params.push(`%${q}%`, q); }
    const rows = await db.query(`${ENTRY_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.EntryDate DESC, e.Id DESC`, params);
    res.json({ entries: rows.slice(0, 300).map((e) => entryDto(e)), total: rows.length });
  });
  r.get('/entries/:id', async (req, res) => {
    view(req);
    const id = intId(req.params.id);
    const e = await db.one(`${ENTRY_SQL} WHERE e.Id = ?`, [id]);
    if (!e) throw notFound('القيد مش موجود');
    const lines = await db.query('SELECT l.*, a.Code, a.Name AS AccountName FROM JournalLines l JOIN Accounts a ON a.Id = l.AccountId WHERE l.EntryId = ? ORDER BY l.Id', [id]);
    res.json({ entry: entryDto(e, lines) });
  });
  r.post('/entries', async (req, res) => {
    need(req.user, 'ledger.post');
    const b = req.body || {};
    const desc = str(b.description, 300);
    if (!desc || desc.length < 3) throw bad('اكتب بيان القيد');
    const date = dateOr(b.date, businessDate());
    if (!Array.isArray(b.lines)) throw bad('القيد من غير سطور');
    const lines = b.lines.map((l) => ({ accountId: intId(l.accountId, 'الحساب'), debit: l.debit ? parseMoney(l.debit, 'المدين') : 0, credit: l.credit ? parseMoney(l.credit, 'الدائن') : 0, memo: str(l.memo, 200) }));
    const out = await db.tx(async (t) => {
      const e = await post(t, req.user, { date, source: 'manual', description: desc, lines });
      await audit(t, req.user, 'journal.create', 'JournalEntry', e.id, { now: { no: e.no, date, description: desc } });
      return e;
    });
    res.status(201).json({ entry: { id: out.id, no: out.no } });
  });
  r.post('/entries/:id/reverse', async (req, res) => {
    need(req.user, 'ledger.reverse');
    const id = intId(req.params.id);
    const reason = str(req.body?.reason, 200);
    if (!reason || reason.length < 3) throw bad('اكتب سبب العكس');
    const out = await db.tx(async (t) => {
      const e = await reverse(t, req.user, id, reason);
      await audit(t, req.user, 'journal.reverse', 'JournalEntry', id, { now: { reversalNo: e.no }, note: reason });
      return e;
    });
    res.json({ entry: { id: out.id, no: out.no } });
  });

  // ======== ميزان المراجعة وكشف الحساب ========
  r.get('/trial', async (req, res) => {
    view(req);
    const from = dateOr(req.query.from, businessDate().slice(0, 8) + '01'), to = dateOr(req.query.to, businessDate());
    const accs = await db.query('SELECT * FROM Accounts ORDER BY Code');
    const agg = await db.query(
      `SELECT l.AccountId, SUM(CASE WHEN e.EntryDate < ? THEN l.Debit ELSE 0 END) AS OpD, SUM(CASE WHEN e.EntryDate < ? THEN l.Credit ELSE 0 END) AS OpC,
              SUM(CASE WHEN e.EntryDate >= ? AND e.EntryDate <= ? THEN l.Debit ELSE 0 END) AS D, SUM(CASE WHEN e.EntryDate >= ? AND e.EntryDate <= ? THEN l.Credit ELSE 0 END) AS C
         FROM JournalLines l JOIN JournalEntries e ON e.Id = l.EntryId WHERE e.EntryDate <= ? GROUP BY l.AccountId`, [from, from, from, to, from, to, to]);
    const m = Object.fromEntries(agg.map((x) => [x.AccountId, x]));
    const rows = accs.map((a) => {
      const x = m[a.Id];
      const od = cents(x?.OpD || 0), oc = cents(x?.OpC || 0), d = cents(x?.D || 0), c = cents(x?.C || 0);
      return { ...acctDto(a), open: pounds(balanceOf(a.Type, od, oc)), debit: pounds(d), credit: pounds(c), close: pounds(balanceOf(a.Type, od + d, oc + c)), _d: od + d, _c: oc + c, _m: d + c + od + oc };
    });
    // الإجماليات من الحسابات الفرعية بس (التجميعية ملهاش قيود)
    const leaf = rows.filter((x) => !x.isGroup);
    const totals = { debit: pounds(leaf.reduce((a, x) => a + cents(x.debit), 0)), credit: pounds(leaf.reduce((a, x) => a + cents(x.credit), 0)),
      closeDebit: pounds(leaf.reduce((a, x) => a + Math.max(0, x._d - x._c), 0)), closeCredit: pounds(leaf.reduce((a, x) => a + Math.max(0, x._c - x._d), 0)) };
    res.json({ from, to, rows: rows.map(({ _d, _c, _m, ...x }) => x), totals, balanced: totals.closeDebit === totals.closeCredit });
  });
  r.get('/statement', async (req, res) => {
    view(req);
    const id = intId(req.query.accountId, 'الحساب');
    const a = await db.one('SELECT * FROM Accounts WHERE Id = ?', [id]);
    if (!a) throw notFound('الحساب مش موجود');
    const from = dateOr(req.query.from, businessDate().slice(0, 8) + '01'), to = dateOr(req.query.to, businessDate());
    // حساب تجميعي: كل الحسابات الفرعية تحته
    const ids = [id];
    for (let i = 0; i < ids.length; i++) for (const k of await db.query('SELECT Id FROM Accounts WHERE ParentId = ?', [ids[i]])) ids.push(k.Id);
    const ph = ids.map(() => '?').join(',');
    const op = await db.one(`SELECT SUM(l.Debit) AS D, SUM(l.Credit) AS C FROM JournalLines l JOIN JournalEntries e ON e.Id = l.EntryId WHERE l.AccountId IN (${ph}) AND e.EntryDate < ?`, [...ids, from]);
    let run = balanceOf(a.Type, cents(op?.D || 0), cents(op?.C || 0));
    const opening = run;
    const lines = await db.query(
      `SELECT l.*, e.EntryNo, e.EntryDate, e.Description, e.Id AS EId, ac.Name AS AccName FROM JournalLines l JOIN JournalEntries e ON e.Id = l.EntryId JOIN Accounts ac ON ac.Id = l.AccountId
        WHERE l.AccountId IN (${ph}) AND e.EntryDate >= ? AND e.EntryDate <= ? ORDER BY e.EntryDate, e.Id, l.Id`, [...ids, from, to]);
    const rows = lines.map((l) => {
      run += balanceOf(a.Type, cents(l.Debit), cents(l.Credit));
      return { entryId: l.EId, no: l.EntryNo, date: toDateStr(l.EntryDate), description: l.Description, account: l.AccName, memo: l.Memo, debit: Number(l.Debit), credit: Number(l.Credit), balance: pounds(run) };
    });
    res.json({ account: acctDto(a), from, to, opening: pounds(opening), rows, closing: pounds(run) });
  });
  return r;
}
