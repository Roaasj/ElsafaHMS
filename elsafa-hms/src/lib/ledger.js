// دليل الحسابات والقيود اليومية: القيد المزدوج بالقروش، الإلغاء بقيد عكسي، وقفل الفترة.
// أي ربط بين عملية (مثلًا مستحقات الأطباء) وحساب بيتعمل من AccountMap (إعدادات)، مفيش كود حساب ثابت هنا.
import { bad, conflict, cents, pounds } from './util.js';
import { can } from './auth.js';
import { businessDate } from './cashier.js';

export const TYPES = { asset: 'أصول', liability: 'خصوم', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' };
const DEBIT_NORMAL = new Set(['asset', 'expense']);
/** عمليات البرنامج اللي بتتقيّد، وكل واحدة بتتربط بحساب من الإعدادات */
export const MAP_KEYS = {
  'doctor.expense': { name: 'مصروف أتعاب الأطباء', type: 'expense' },
  'doctor.payable': { name: 'مستحقات الأطباء (التزام)', type: 'liability' },
  'doctor.tax': { name: 'ضريبة أتعاب الأطباء المستحقة', type: 'liability' },
  'cash.main': { name: 'الخزينة (النقدية)', type: 'asset' },
  'cash.card': { name: 'متحصلات الفيزا (تحت التحصيل)', type: 'asset' },
  'bank.main': { name: 'البنك', type: 'asset' },
  'patient.credit': { name: 'مدينو المرضى (الآجل)', type: 'asset' },
  'patient.deposits': { name: 'تأمينات ودفعات المرضى تحت الحساب', type: 'liability' },
  'revenue.clinic': { name: 'إيراد العيادات', type: 'revenue' },
  'revenue.emergency': { name: 'إيراد الطوارئ', type: 'revenue' },
  'revenue.lab': { name: 'إيراد المعمل', type: 'revenue' },
  'revenue.radiology': { name: 'إيراد الأشعة', type: 'revenue' },
  'revenue.drugs': { name: 'إيراد الأدوية (الصيدلية)', type: 'revenue' },
  'revenue.supplies': { name: 'إيراد المستلزمات', type: 'revenue' },
  'revenue.inpatient': { name: 'إيراد الإقامة والعمليات', type: 'revenue' },
  'revenue.other': { name: 'إيرادات أخرى ومرتجعات غير مصنفة', type: 'revenue' },
  'supplier.expense': { name: 'مشتريات الموردين (فواتير الموردين)', type: 'expense' },
  'supplier.payable': { name: 'الموردون (التزام)', type: 'liability' },
  'cheques.payable': { name: 'شيكات صادرة مستحقة الدفع', type: 'liability' },
  'expense.default': { name: 'مصروفات (البند الافتراضي)', type: 'expense' },
  'oblig.debit': { name: 'التزامات وأقساط (الطرف المدين عند التسجيل)', type: 'expense' },
  'oblig.payable': { name: 'الالتزامات والأقساط المستحقة', type: 'liability' },
};
export const SOURCES = {
  manual: 'قيد يدوي', payout_accrual: 'اعتماد مستحقات دكتور', payout_pay: 'صرف مستحقات دكتور', reversal: 'قيد عكسي', shift: 'إيرادات وردية',
  supplier_invoice: 'فاتورة مورد', supplier_pay: 'دفعة مورد', supplier_cheque_clear: 'صرف شيك مورد', expense: 'مصروف',
  obligation: 'تسجيل التزام', obligation_adj: 'تعديل قسط', installment_pay: 'سداد قسط', installment_cheque_clear: 'صرف شيك قسط',
};

// قالب بداية مناسب لمستشفى. بيتزرع مرة واحدة والمدير يعدّل فيه براحته
const TEMPLATE = [
  ['1', 'الأصول', 'asset', null, 1], ['11', 'النقدية والبنوك', 'asset', '1', 1], ['1101', 'الخزينة الرئيسية', 'asset', '11', 0, 'cash.main'], ['1102', 'البنك', 'asset', '11', 0],
  ['12', 'العملاء', 'asset', '1', 1], ['1201', 'جهات التعاقد والتأمين', 'asset', '12', 0],
  ['13', 'المخزون', 'asset', '1', 1], ['1301', 'مخزن الأدوية', 'asset', '13', 0], ['1302', 'مخزن المستلزمات', 'asset', '13', 0],
  ['2', 'الخصوم', 'liability', null, 1], ['21', 'الموردون', 'liability', '2', 1], ['2101', 'الموردون', 'liability', '21', 0],
  ['22', 'مستحقات الأطباء', 'liability', '2', 1], ['2201', 'مستحقات الأطباء', 'liability', '22', 0, 'doctor.payable'],
  ['23', 'الضرائب المستحقة', 'liability', '2', 1], ['2301', 'ضريبة أتعاب الأطباء', 'liability', '23', 0, 'doctor.tax'],
  ['24', 'الالتزامات والأقساط', 'liability', '2', 1], ['2401', 'الأقساط والالتزامات', 'liability', '24', 0],
  ['3', 'حقوق الملكية', 'equity', null, 1], ['3101', 'رأس المال', 'equity', '3', 0], ['3201', 'أرباح مرحّلة', 'equity', '3', 0],
  ['4', 'الإيرادات', 'revenue', null, 1], ['4101', 'إيرادات العيادات', 'revenue', '4', 0], ['4102', 'إيرادات المعمل', 'revenue', '4', 0], ['4103', 'إيرادات الأشعة', 'revenue', '4', 0],
  ['4104', 'إيرادات الإقامة والعمليات', 'revenue', '4', 0], ['4105', 'إيرادات الصيدلية', 'revenue', '4', 0],
  ['5', 'المصروفات', 'expense', null, 1], ['5101', 'أتعاب الأطباء', 'expense', '5', 0, 'doctor.expense'], ['5102', 'مرتبات وأجور', 'expense', '5', 0],
  ['5103', 'مصروفات تشغيل', 'expense', '5', 0], ['5104', 'مشتريات أدوية ومستلزمات', 'expense', '5', 0],
];
// حسابات اتضافت للقالب في شرايح بعد الأولى. بتتضاف لو كودها مش موجود (من غير ما نلمس اللي المدير عدّله)
const MORE = [
  ['1103', 'متحصلات الفيزا (تحت التحصيل)', 'asset', '11', 0, 'cash.card'], ['1202', 'مدينو المرضى (الآجل)', 'asset', '12', 0, 'patient.credit'],
  ['2102', 'شيكات صادرة مستحقة الدفع', 'liability', '2', 0, 'cheques.payable'], ['25', 'إيداعات المرضى', 'liability', '2', 1], ['2501', 'تأمينات ودفعات المرضى تحت الحساب', 'liability', '25', 0, 'patient.deposits'],
  ['4106', 'إيرادات الطوارئ', 'revenue', '4', 0, 'revenue.emergency'], ['4107', 'إيرادات أخرى ومرتجعات غير مصنفة', 'revenue', '4', 0, 'revenue.other'],
  ['5105', 'التزامات وأقساط', 'expense', '5', 0, 'oblig.debit'],
];
const MAP_DEFAULT_CODE = {
  'bank.main': '1102', 'revenue.clinic': '4101', 'revenue.lab': '4102', 'revenue.radiology': '4103', 'revenue.inpatient': '4104', 'revenue.drugs': '4105', 'revenue.supplies': '4105',
  'supplier.expense': '5104', 'supplier.payable': '2101', 'expense.default': '5103', 'oblig.payable': '2401',
};
/** بيزرع القالب أول مرة، وبعدها بيكمّل الحسابات وربط العمليات الناقصة بس (idempotent) */
export async function ensureLedger(db) {
  let added = 0;
  await db.tx(async (t) => {
    const empty = !Number((await t.one('SELECT COUNT(*) AS N FROM Accounts'))?.N);
    const ids = Object.fromEntries((await t.query('SELECT Id, Code FROM Accounts')).map((a) => [a.Code, a.Id]));
    let i = Number((await t.one('SELECT MAX(SortOrder) AS M FROM Accounts'))?.M) || 0;
    const have = new Set((await t.query('SELECT [Key] FROM AccountMap')).map((x) => x.Key));
    for (const [code, name, type, parent, grp, key] of [...(empty ? TEMPLATE : []), ...MORE]) {
      if (!ids[code]) {
        ids[code] = await t.insert('Accounts', { Code: code, Name: name, Type: type, ParentId: parent ? ids[parent] ?? null : null, IsGroup: grp ? 1 : 0, Active: 1, SortOrder: ++i });
        added++;
      }
      if (key && !have.has(key) && ids[code]) { await t.insert('AccountMap', { '[Key]': key, AccountId: ids[code] }); have.add(key); }
    }
    for (const [key, code] of Object.entries(MAP_DEFAULT_CODE)) {
      if (!have.has(key) && ids[code]) { await t.insert('AccountMap', { '[Key]': key, AccountId: ids[code] }); have.add(key); }
    }
  });
  return added;
}

async function setting(db, key, def) { return (await db.one('SELECT Value FROM AppSettings WHERE [Key] = ?', [key]))?.Value ?? def; }
export const ledgerOn = async (db) => (await setting(db, 'ledgerEnabled', 'on')) !== 'off';
export const lockDate = async (db) => (await setting(db, 'ledgerLockDate', '')) || null;

export const balanceOf = (type, debit, credit) => (DEBIT_NORMAL.has(type) ? debit - credit : credit - debit);

/** حساب من الإعدادات بمفتاح العملية. لو مش متربط: خطأ واضح (مش تخطّي صامت) */
export async function mappedAccount(t, key) {
  const m = await t.one('SELECT a.Id, a.Active, a.IsGroup, a.Name FROM AccountMap m JOIN Accounts a ON a.Id = m.AccountId WHERE m.[Key] = ?', [key]);
  if (!m) throw conflict(`ربط القيود ناقص: «${MAP_KEYS[key]?.name || key}» مش متربط بحساب. اربطه من إعدادات الدفاتر`);
  if (!m.Active || m.IsGroup) throw conflict(`الحساب «${m.Name}» المربوط بـ «${MAP_KEYS[key]?.name || key}» موقوف أو تجميعي. اربط حساب تاني من إعدادات الدفاتر`);
  return m.Id;
}

/**
 * ترحيل قيد. lines: [{ accountId | key, debit, credit, memo }] بالقروش. لازم المدين = الدائن.
 * بيرفض لو التاريخ في فترة مقفولة (إلا لمن يملك ledger.lockOverride).
 */
export async function post(t, user, { date, source, sourceId = null, description, lines, reversalOf = null }) {
  const day = date || businessDate();
  const lk = await lockDate(t);
  if (lk && day <= lk && !can(user, 'ledger.lockOverride')) throw conflict(`الدفاتر مقفولة لحد ${lk}. تاريخ القيد ${day} داخل فترة مقفولة`);
  const rows = [];
  for (const l of lines) {
    const accountId = l.accountId || (await mappedAccount(t, l.key));
    const debit = Math.round(Number(l.debit) || 0), credit = Math.round(Number(l.credit) || 0);
    if (debit < 0 || credit < 0 || (debit > 0 && credit > 0) || (debit === 0 && credit === 0)) throw bad('كل سطر في القيد لازم يكون مدين أو دائن بمبلغ أكبر من صفر');
    rows.push({ accountId, debit, credit, memo: l.memo ? String(l.memo).slice(0, 200) : null });
  }
  if (rows.length < 2) throw bad('القيد لازم يكون فيه طرفين على الأقل');
  const dr = rows.reduce((a, x) => a + x.debit, 0), cr = rows.reduce((a, x) => a + x.credit, 0);
  if (dr !== cr) throw bad(`القيد مش متوازن: المدين ${pounds(dr)} والدائن ${pounds(cr)}`);
  const ids = [...new Set(rows.map((x) => x.accountId))];
  const accs = await t.query(`SELECT Id, Name, Active, IsGroup FROM Accounts WHERE Id IN (${ids.map(() => '?').join(',')})`, ids);
  if (accs.length !== ids.length) throw bad('فيه حساب في القيد مش موجود');
  for (const a of accs) {
    if (a.IsGroup) throw bad(`«${a.Name}» حساب تجميعي. اختار حساب فرعي`);
    if (!a.Active) throw bad(`«${a.Name}» حساب موقوف`);
  }
  const no = await t.nextNumber('jv');
  const id = await t.insert('JournalEntries', { EntryNo: no, EntryDate: day, Source: source, SourceId: sourceId, Description: String(description).slice(0, 300), Status: 'posted', ReversalOf: reversalOf, CreatedAt: new Date(), CreatedBy: user.id });
  for (const x of rows) await t.insert('JournalLines', { EntryId: id, AccountId: x.accountId, Debit: pounds(x.debit), Credit: pounds(x.credit), Memo: x.memo });
  return { id, no };
}

/** قيد عكسي لقيد متسجل (الأصلي بيتعلّم «معكوس»). مفيش مسح */
export async function reverse(t, user, entryId, reason, date) {
  const e = await t.one('SELECT * FROM JournalEntries WHERE Id = ?', [entryId]);
  if (!e) throw bad('القيد مش موجود');
  if (e.Status !== 'posted' || e.ReversalOf) throw conflict('القيد ده اتعكس قبل كده أو هو نفسه قيد عكسي');
  const lines = await t.query('SELECT * FROM JournalLines WHERE EntryId = ? ORDER BY Id', [entryId]);
  const r = await post(t, user, {
    date, source: 'reversal', sourceId: entryId, reversalOf: entryId,
    description: `عكس قيد ${e.EntryNo}: ${reason}`,
    lines: lines.map((l) => ({ accountId: l.AccountId, debit: cents(l.Credit), credit: cents(l.Debit), memo: l.Memo })),
  });
  await t.run("UPDATE JournalEntries SET Status = 'reversed' WHERE Id = ?", [entryId]);
  return r;
}
/** عكس كل القيود المتسجلة لمصدر معين (مثلًا اعتماد مستحق اتلغى) */
export async function reverseSource(t, user, source, sourceId, reason) {
  const es = await t.query("SELECT Id FROM JournalEntries WHERE Source = ? AND SourceId = ? AND Status = 'posted' AND ReversalOf IS NULL", [source, sourceId]);
  for (const e of es) await reverse(t, user, e.Id, reason);
  return es.length;
}
