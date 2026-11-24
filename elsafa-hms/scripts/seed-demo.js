// بيانات تجريبية: مستخدمين، خدمات وأسعار، أطباء ومواعيد ونسب
// الاستخدام:  npm run seed:demo
// (على SQL Server: شغّله على قاعدة التجربة بس، مش على قاعدة التشغيل)
import { seedLabTests, linkLabServices } from '../src/lib/lab-tests.js';
import { seedStores } from '../src/lib/stock.js';
import { seedClinics } from '../src/lib/clinics.js';
import { seedUnits } from '../src/lib/units.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { searchKey } from '../shared/text.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_USERS = [
  { Username: 'manager', FullName: 'د. مدير المستشفى', Role: 'manager', pw: 'Safa@2026' },
  { Username: 'super', FullName: 'مشرف الاستقبال', Role: 'supervisor', pw: 'Safa@2026' },
  { Username: 'reception', FullName: 'موظف استقبال', Role: 'reception', pw: 'Safa@2026', stores: ['مخزن الطوارئ', 'مخزن العيادات'] },
  { Username: 'review', FullName: 'مراجع التعاقدات', Role: 'reviewer', pw: 'Safa@2026' },
  { Username: 'cashier', FullName: 'أمين الخزينة', Role: 'cashier', pw: 'Safa@2026' },
  { Username: 'cashier2', FullName: 'موظفة خزينة المسائي', Role: 'cashier', pw: 'Safa@2026' },
  { Username: 'radio', FullName: 'د. سامح الشناوي', Role: 'radiology', pw: 'Safa@2026' },
  { Username: 'lab', FullName: 'د. ريهام عبد السلام', Role: 'lab', pw: 'Safa@2026' },
  { Username: 'acc', FullName: 'هالة عبد الله', Role: 'accounts', pw: 'Safa@2026' },
  { Username: 'accsuper', FullName: 'أ. وليد الشامي', Role: 'accsuper', pw: 'Safa@2026' },
  { Username: 'store', FullName: 'أ. جمال · أمين المخزن', Role: 'storekeeper', pw: 'Safa@2026', stores: ['مخزن الأدوية الرئيسي', 'مخزن المستلزمات الرئيسي'] },
  { Username: 'nurseor', FullName: 'مشرفة تمريض العمليات', Role: 'nurse', pw: 'Safa@2026', stores: ['مخزن العمليات'] },
  { Username: 'storeacc', FullName: 'أ. نهى · حسابات المخزن', Role: 'storeacc', pw: 'Safa@2026' },
  { Username: 'pharm', FullName: 'د. أمل · الصيدلية', Role: 'pharmacist', pw: 'Safa@2026', stores: ['الصيدلية'] },
  { Username: 'claims', FullName: 'أ. سمر · حسابات التعاقدات', Role: 'claims', pw: 'Safa@2026' },
  { Username: 'fin', FullName: 'أ. هشام · الحسابات العامة', Role: 'finance', pw: 'Safa@2026' },
  { Username: 'nurse4', FullName: 'مشرفة تمريض الدور الرابع', Role: 'nurse', pw: 'Safa@2026', stores: ['مخزن الدور 4'] },
];

// الوحدات الأكبر وحد الطلب لبعض الأصناف التجريبية
export const DEMO_PACKS = {
  'سيفترياكسون 1 جم': { pack: ['علبة', 10], min: 20 }, 'كيتورولاك 30 مجم': { pack: ['علبة', 3], min: 15 }, 'محلول ملح 0.9% 500 مل': { pack: ['كرتونة', 20], min: 40 },
  'باراسيتامول 1 جم محلول': { pack: ['كرتونة', 12], min: 12 }, 'كانيولا 20G': { pack: ['علبة', 50], min: 30 }, 'جوانتي فحص': { pack: ['علبة', 50], min: 50 },
  'رباط ضاغط': { min: 5 }, 'سرنجة 5 مل': { pack: ['علبة', 100], min: 100 },
  'شاش معقم': { pack: ['كرتونة', 50], min: 20 }, 'أموكسيسيلين/كلافيولانيك 1 جم أقراص': { mid: ['شريط', 7], pack: ['علبة', 14], min: 28 },
  'شاش رول طبي': { pack: ['متر', 100], min: 500 }, 'قطن طبي 100 جم': { min: 5 },
};
// أصناف تجريبية: [الاسم، النوع، الوحدة، السعر]
export const DEMO_STOCK = [
  ['سيفترياكسون 1 جم', 'drug', 'فيال', 85], ['سيفوتاكسيم 1 جم', 'drug', 'فيال', 60], ['أموكسيسيلين/كلافيولانيك 1.2 جم', 'drug', 'فيال', 120],
  ['ميترونيدازول 500 مجم محلول', 'drug', 'زجاجة', 35], ['باراسيتامول 1 جم محلول', 'drug', 'زجاجة', 70], ['كيتورولاك 30 مجم', 'drug', 'أمبول', 22],
  ['ديكلوفيناك 75 مجم', 'drug', 'أمبول', 12], ['أوميبرازول 40 مجم', 'drug', 'فيال', 75], ['رانيتيدين 50 مجم', 'drug', 'أمبول', 9],
  ['أوندانسيترون 8 مجم', 'drug', 'أمبول', 28], ['ميتوكلوبراميد 10 مجم', 'drug', 'أمبول', 7], ['ديكساميثازون 8 مجم', 'drug', 'أمبول', 15],
  ['هيدروكورتيزون 100 مجم', 'drug', 'فيال', 45], ['فوروسيميد 20 مجم', 'drug', 'أمبول', 8], ['إينوكسابارين 40 مجم', 'drug', 'سرنجة', 110],
  ['هيبارين 5000 وحدة', 'drug', 'فيال', 55], ['إنسولين سريع', 'drug', 'قلم', 180], ['ترامادول 100 مجم', 'drug', 'أمبول', 18],
  ['سالبيوتامول للنيبولايزر', 'drug', 'أمبول', 6], ['محلول ملح 0.9% 500 مل', 'drug', 'كيس', 22], ['محلول جلوكوز 5% 500 مل', 'drug', 'كيس', 24],
  ['محلول رينجر 500 مل', 'drug', 'كيس', 26], ['محلول جلوكوز ملح 500 مل', 'drug', 'كيس', 25], ['ألبومين 20% 50 مل', 'drug', 'زجاجة', 950],
  ['كانيولا 20G', 'supply', 'قطعة', 18], ['كانيولا 22G', 'supply', 'قطعة', 18], ['جهاز محلول', 'supply', 'قطعة', 12], ['سرنجة 5 مل', 'supply', 'قطعة', 3],
  ['سرنجة 10 مل', 'supply', 'قطعة', 4], ['جوانتي معقم', 'supply', 'جوز', 9], ['جوانتي فحص', 'supply', 'جوز', 2], ['شاش معقم', 'supply', 'باكو', 8],
  ['قطن طبي 100 جم', 'supply', 'لفة', 15], ['بلاستر', 'supply', 'بكرة', 14], ['قسطرة بولية فولي', 'supply', 'قطعة', 35], ['كيس بول', 'supply', 'قطعة', 15],
  ['أنبوبة رايل', 'supply', 'قطعة', 20], ['ماسك أكسجين', 'supply', 'قطعة', 30], ['ماسك نيبولايزر', 'supply', 'قطعة', 35], ['رباط ضاغط', 'supply', 'لفة', 25],
  ['خيط جراحي فيكريل 2/0', 'supply', 'قطعة', 95], ['إلكترود رسم قلب', 'supply', 'قطعة', 4],
  ['أموكسيسيلين/كلافيولانيك 1 جم أقراص', 'drug', 'قرص', 9], ['شاش رول طبي', 'supply', 'سم', 0.5],
];

// [الكود، الاسم، القسم، السعر، الدفع، ليها دكتور، زرار سريع]
export const DEMO_SERVICES = [
  ['CL-001', 'كشف استشاري', 'clinic', 400, 'before', 1, 1],
  ['CL-002', 'كشف أخصائي', 'clinic', 250, 'before', 1, 1],
  ['CL-003', 'إعادة كشف', 'clinic', 100, 'before', 1, 1],
  ['CL-010', 'سونار بطن وحوض', 'clinic', 350, 'after', 1, 1],
  ['CL-011', 'رسم قلب', 'clinic', 150, 'after', 0, 1],
  ['CL-012', 'غيار جرح', 'clinic', 80, 'after', 0, 0],
  ['ER-001', 'كشف طوارئ', 'emergency', 200, 'after', 1, 1],
  ['ER-002', 'جلسة نيبولايزر', 'emergency', 75, 'after', 0, 1],
  ['ER-003', 'خياطة جرح بسيط', 'emergency', 250, 'after', 0, 1],
  ['ER-004', 'تركيب كانيولا ومحاليل', 'emergency', 150, 'after', 0, 1],
  ['ER-005', 'حقنة عضل/وريد', 'emergency', 40, 'after', 0, 0],
  ['LAB-001', 'صورة دم كاملة CBC', 'lab', 120, 'before', 0, 1],
  ['LAB-002', 'سكر صائم', 'lab', 40, 'before', 0, 1],
  ['LAB-003', 'وظائف كبد', 'lab', 220, 'before', 0, 1],
  ['LAB-004', 'وظائف كلى', 'lab', 200, 'before', 0, 1],
  ['LAB-005', 'صورة دهون كاملة', 'lab', 260, 'before', 0, 0],
  ['LAB-006', 'تحليل بول كامل', 'lab', 60, 'before', 0, 1],
  ['LAB-007', 'هرمون الغدة TSH', 'lab', 180, 'before', 0, 0],
  ['LAB-008', 'سكر تراكمي HbA1c', 'lab', 190, 'before', 0, 0],
  ['LAB-009', 'تحليل براز', 'lab', 60, 'before', 0, 0],
  ['LAB-010', 'سي آر بي CRP', 'lab', 120, 'before', 0, 0],
  ['LAB-011', 'فيتامين د', 'lab', 450, 'before', 0, 0],
  ['RAD-001', 'أشعة عادية صدر', 'radiology', 150, 'before', 0, 1],
  ['RAD-002', 'أشعة عادية عظام', 'radiology', 170, 'before', 0, 1],
  ['RAD-003', 'سونار بطن وحوض', 'radiology', 300, 'before', 1, 1],
  ['RAD-004', 'أشعة مقطعية بدون صبغة', 'radiology', 900, 'before', 1, 1],
  ['RAD-005', 'رنين مغناطيسي', 'radiology', 1600, 'before', 1, 1],
  ['RAD-006', 'ماموجرام', 'radiology', 700, 'before', 1, 0],
  ['RAD-007', 'سونار غدة درقية', 'radiology', 350, 'before', 1, 0],
  ['RAD-008', 'سونار حمل', 'radiology', 300, 'before', 1, 1],
  ['RAD-009', 'أشعة مقطعية على المخ', 'radiology', 1000, 'before', 1, 0],
  ['IP-001', 'زيارة طبيب', 'ward', 300, 'after', 1, 1, null, 'visit'],
  ['IP-007', 'زيارة استشاري', 'ward', 500, 'after', 1, 1, null, 'visit'],
  ['IP-002', 'أكسجين (ساعة)', 'ward', 50, 'after', 0, 1],
  ['IP-003', 'جلسة نيبولايزر (داخلي)', 'ward', 90, 'after', 0, 1],
  ['IP-004', 'رسم قلب (داخلي)', 'ward', 180, 'after', 0, 0],
  ['IP-005', 'غيار جرح (داخلي)', 'ward', 120, 'after', 0, 1],
  ['IP-006', 'فوتوثيرابي (يوم)', 'ward', 400, 'after', 0, 0],
  ['OR-001', 'عملية زايدة دودية', 'or', 7000, 'after', 1, 1],
  ['OR-002', 'أتعاب تخدير', 'or', 1500, 'after', 1, 1, null, 'fee', 1],
  ['OR-003', 'غرفة عمليات (ساعة)', 'or', 1200, 'after', 0, 1],
  ['OR-004', 'باكدج ولادة قيصرية شامل ليلتين', 'or', 16000, 'after', 1, 1, 2],
  ['OR-005', 'منظار مرارة', 'or', 12000, 'after', 1, 0],
  ['OR-006', 'أتعاب جراح', 'or', 3000, 'after', 1, 1, null, 'fee', 1],
  ['OR-007', 'أتعاب مساعد جراح', 'or', 800, 'after', 1, 0, null, 'fee', 1],
];

// غرف تجريبية على الأدوار الحقيقية: [الدور، رقم الغرفة، الدرجة، عدد الأسرّة]
export const DEMO_ROOMS = [
  [3, '301', 'عادية', 2], [3, '302', 'عادية', 2], [3, '303', 'ممتازة', 1], [3, '304', 'ممتازة', 1], [3, 'حضانة 1', 'حضانة', 6],
  [4, '401', 'عادية', 3], [4, '402', 'عادية', 2], [4, '403', 'ممتازة', 1], [4, '404', 'ممتازة', 1], [4, '405', 'جناح', 1],
  [6, 'عناية 1', 'عناية مركزة', 6], [6, 'عناية 2', 'عناية مركزة', 2],
  [7, '701', 'ممتازة', 1], [7, '702', 'ممتازة', 1], [7, '703', 'جناح', 1], [7, '704', 'جناح', 1],
  [8, '801', 'جناح', 1], [8, '802', 'جناح ملكي', 1], [8, '803', 'جناح ملكي', 1],
];
export const DEMO_CLASS_PRICES = { 'عادية': [600, 3000], 'ممتازة': [950, 5000], 'جناح': [1600, 8000], 'جناح ملكي': [2800, 12000], 'عناية مركزة': [3500, 15000], 'حضانة': [1800, 8000] };

export const DEMO_DOCTORS = [
  ['د. أحمد السيد', 'باطنة', 40, [[0, '10:00', '14:00'], [2, '10:00', '14:00'], [4, '17:00', '21:00']]],
  ['د. منى عبد الرحمن', 'أطفال', 45, [[0, '17:00', '21:00'], [1, '17:00', '21:00'], [3, '17:00', '21:00'], [5, '12:00', '16:00']]],
  ['د. خالد إبراهيم', 'عظام', 40, [[1, '12:00', '16:00'], [3, '12:00', '16:00'], [6, '18:00', '22:00']]],
  ['د. سارة محمود', 'نسا وتوليد', 40, [[0, '09:00', '13:00'], [2, '18:00', '22:00'], [4, '09:00', '13:00'], [6, '10:00', '14:00']]],
  ['د. محمد فتحي', 'أشعة', 30, [[0, '08:00', '20:00'], [1, '08:00', '20:00'], [2, '08:00', '20:00'], [3, '08:00', '20:00'], [4, '08:00', '20:00'], [5, '08:00', '20:00'], [6, '08:00', '20:00']]],
  ['د. ياسر النجار', 'طوارئ', 35, [[0, '00:00', '23:59'], [1, '00:00', '23:59'], [2, '00:00', '23:59'], [3, '00:00', '23:59'], [4, '00:00', '23:59'], [5, '00:00', '23:59'], [6, '00:00', '23:59']]],
  ['د. هبة الشربيني', 'جلدية', 40, [[1, '18:00', '22:00'], [4, '18:00', '22:00']]],
];

export async function seedDemo(db, { clinics = true } = {}) {
  const now = new Date();
  const existing = await db.one('SELECT COUNT(*) AS N FROM Users');
  if (Number(existing.N) > 0) return false;
  await seedStores(db);
  const storeIds = new Map((await db.query('SELECT Id, Name FROM Stores')).map((x) => [x.Name, x.Id]));
  for (const u of DEMO_USERS) {
    await db.insert('Users', { Username: u.Username, FullName: u.FullName, Role: u.Role, PasswordHash: await hashPassword(u.pw), Active: 1, CreatedAt: now,
      StoreIds: JSON.stringify((u.stores || []).map((n) => storeIds.get(n)).filter(Boolean)) });
  }
  const since = new Date(now.getTime() - 86400e3 * 30);
  const svcIds = {};
  for (let i = 0; i < DEMO_SERVICES.length; i++) {
    const [code, name, dept, price, pay, doc, quick, nights, tcat, open] = DEMO_SERVICES[i];
    const id = await db.insert('Services', {
      Code: code, Name: name, SearchKey: searchKey(name), Dept: dept, PayTiming: pay, HasDoctor: doc, Quick: quick,
      SortOrder: i, Active: 1, CreatedAt: now, IncludedNights: nights || null, TicketCat: tcat || null, OpenPrice: open ? 1 : 0,
    });
    svcIds[code] = id;
    await db.insert('ServicePrices', { ServiceId: id, Price: price, EffectiveFrom: since, ChangedBy: null });
  }
  for (const [name, spec, pct, slots] of DEMO_DOCTORS) {
    const id = await db.insert('Doctors', { Name: name, Specialty: spec, Active: 1 });
    for (const [wd, from, to] of slots) await db.insert('DoctorSchedule', { DoctorId: id, Weekday: wd, FromTime: from, ToTime: to });
    await db.insert('DoctorShares', { DoctorId: id, ServiceId: null, Dept: null, Pct: pct });
    if (spec === 'باطنة') await db.insert('DoctorShares', { DoctorId: id, ServiceId: svcIds['CL-010'], Dept: null, Pct: 30 });
  }
  // أسعار الدرجات والغرف (الأدوار والدرجات نفسها بتيجي من تحديث القاعدة 002)
  const classes = new Map((await db.query('SELECT Id, Name FROM RoomClasses')).map((c) => [c.Name, c.Id]));
  for (const [name, [price, dep]] of Object.entries(DEMO_CLASS_PRICES)) {
    await db.run('UPDATE RoomClasses SET NightPrice = ?, Deposit = ? WHERE Id = ?', [price, dep, classes.get(name)]);
  }
  const floors = new Map((await db.query('SELECT Id, Number FROM Floors')).map((f) => [f.Number, f.Id]));
  for (const [fl, no, cls, n] of DEMO_ROOMS) {
    const rid = await db.insert('Rooms', { FloorId: floors.get(fl), Number: no, ClassId: classes.get(cls), Active: 1 });
    const labels = n === 1 ? ['1'] : Array.from({ length: n }, (_, i) => ['أ', 'ب', 'ج', 'د', 'هـ', 'و'][i] || String(i + 1));
    for (const l of labels) await db.insert('Beds', { RoomId: rid, Label: l, Status: 'free', Active: 1 });
  }
  // جهات تعاقد تجريبية
  const sid = Object.fromEntries((await db.query('SELECT Id, Code FROM Services')).map((x) => [x.Code, x.Id]));
  const all = (pct) => ({ clinic: pct, emergency: pct, lab: pct, radiology: pct, ward: pct, or: pct, drugs: pct, supplies: pct });
  const P = [
    { Name: 'نقابة المهندسين', Kind: 'نقابة', PriceMode: 'discount', DiscountPct: 10, RequiredDocs: 'كارنيه النقابة ساري + خطاب تحويل', tiers: [['كارنيه أ', all(100)], ['كارنيه ب', all(50)]], rules: [['CL-012', 'excluded'], ['RAD-005', 'approval'], ['RAD-004', 'approval']] },
    { Name: 'شركة مصر للتأمين', Kind: 'شركة تأمين', PriceMode: 'list', VisitCap: 5000, RequiredDocs: 'كارت التأمين + البطاقة', tiers: [['ذهبي', all(80)], ['فضي', { ...all(60), ward: 70 }]], rules: [['RAD-005', 'approval'], ['OR-001', 'approval'], ['OR-004', 'approval']],
      prices: [['CL-001', 350], ['CL-002', 220], ['LAB-001', 100], ['RAD-005', 1400]] },
    { Name: 'هيئة قناة السويس', Kind: 'هيئة', PriceMode: 'cash', ValidTo: '2026-12-31', tiers: [['موظف', all(100)], ['أسرة', { clinic: 75, emergency: 100, lab: 75, radiology: 75, ward: 75, or: 75 }]], rules: [] },
  ];
  for (const x of P) {
    const pid = await db.insert('Payers', {
      Name: x.Name, Kind: x.Kind, PriceMode: x.PriceMode, DiscountPct: x.DiscountPct ?? null, RequiredDocs: x.RequiredDocs ?? null, VisitCap: x.VisitCap ?? null,
      ValidFrom: '2026-01-01', ValidTo: x.ValidTo ?? null, Active: 1, CreatedAt: now,
    });
    for (let i = 0; i < x.tiers.length; i++) {
      const [tn, cov] = x.tiers[i];
      const tid = await db.insert('PayerTiers', { PayerId: pid, Name: tn, SortOrder: i, Active: 1 });
      for (const [d, pct] of Object.entries(cov)) await db.insert('TierCoverage', { TierId: tid, Dept: d, Pct: pct });
    }
    for (const [c, r] of x.rules) await db.insert('PayerRules', { PayerId: pid, ServiceId: sid[c], '[Rule]': r });
    for (const [c, pr] of x.prices || []) await db.insert('PayerPrices', { PayerId: pid, ServiceId: sid[c], Price: pr });
  }
  for (let i = 0; i < DEMO_STOCK.length; i++) {
    const [name, kind, unit, price] = DEMO_STOCK[i];
    const n = DEMO_STOCK.slice(0, i + 1).filter((x) => x[1] === kind).length;
    const pk = DEMO_PACKS[name] || {};
    await db.insert('StockItems', { Code: (kind === 'drug' ? 'D-' : 'S-') + String(n).padStart(4, '0'), Name: name, SearchKey: searchKey(name), Kind: kind, Unit: unit, Price: price, Active: 1, CreatedAt: now,
      MidUnit: pk.mid?.[0] || null, MidQty: pk.mid?.[1] || null, PackUnit: pk.pack?.[0] || null, PackQty: pk.pack?.[1] || null, MinQty: pk.min ?? null });
  }
  await seedLabTests(db);
  await linkLabServices(db);
  await db.run('UPDATE LabTests SET [External] = 1, ExternalLab = ?, Hours = 72 WHERE Code = ?', ['معمل البرج (خارجي)', 'VITD']);
  await seedUnits(db);
  if (clinics) await seedClinics(db); // الخطوط الأساسية المحاسبية بتقفلها عشان مخازن العيادات الفاضية ما تدخلش في تقارير القيمة
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('seed-demo.js')) {
  const config = loadConfig();
  if (config.db.driver === 'sqlite') mkdirSync(path.dirname(config.db.sqlite.file), { recursive: true });
  const db = await createDb(config.db);
  const done = await seedDemo(db);
  if (done) { const { applyTemplate } = await import('./apply-template.js'); await applyTemplate(db, path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'elsafa.json'), config); }
  console.log(done ? 'تمام: البيانات التجريبية اتضافت. الدخول: manager / super / reception  وكلمة السر Safa@2026' : 'القاعدة فيها مستخدمين بالفعل، ما اتضافش حاجة.');
  await db.close();
}
