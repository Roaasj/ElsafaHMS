// سجل الإعدادات: كل إعداد في البرنامج بيتسجل هنا (المجموعة، النوع، الافتراضي).
// الشاشة والتحقق بيتولدوا من السجل، وأي موديول جديد يضيف إعداداته هنا فتظهر لوحدها.
// القيم نفسها بتتخزن في AppSettings، فمفيش حاجة خاصة بمستشفى معينة في الكود.

import { checkCurrency } from '../../shared/money.js';

export const GROUPS = [
  { key: 'identity', name: 'هوية المستشفى', icon: 'sparkle', hint: 'الاسم واللوجو والألوان اللي بتظهر في الشاشات والطباعة' },
  { key: 'time', name: 'الوقت والورديات', icon: 'clock', hint: 'المنطقة الزمنية ومواعيد الورديات وبداية يوم الخزينة' },
  { key: 'cashier', name: 'الخزينة والتحصيل', icon: 'cashbox', hint: 'طريقة التحصيل وإيصالات الدفع' },
  { key: 'inpatient', name: 'الإقامة', icon: 'bed', hint: 'ميعاد حساب يوم الخروج' },
  { key: 'lab', name: 'المعمل والأشعة', icon: 'flask', hint: 'اعتماد النتايج وتسليم الأشعة' },
  { key: 'stock', name: 'التذاكر والمخازن', icon: 'box', hint: 'نظام التذكرة وخصم المخزن' },
  { key: 'finance', name: 'الحسابات العامة', icon: 'wallet', hint: 'ضريبة الدكاترة ويوم الصرف' },
  { key: 'patient', name: 'حقول المريض', icon: 'user', hint: 'إيه المطلوب وإيه الاختياري عند تسجيل المريض (عيادات، طوارئ، إقامة)' },
  { key: 'modules', name: 'الأقسام المفعّلة', icon: 'layers', hint: 'اقفل أو افتح أقسام كاملة. القسم المقفول بيختفي ومحدش يقدر يستخدمه (حتى المدير) لحد ما ترجّعه.' },
  { key: 'currency', name: 'العملة', icon: 'cash', hint: 'عملة المبالغ وشكل عرضها. الكود وعدد الخانات بيتقفلوا بعد أول معاملة مالية' },
];

// type: text | color | time | number | select | bool | tz
// on/off: القيم المخزنة للـ bool (عشان الإعدادات القديمة كانت بصيغ مختلفة)
export const REGISTRY = [
  // ---- الهوية ----
  { key: 'hospitalName', group: 'identity', type: 'text', label: 'اسم المستشفى', def: 'اسم المستشفى', max: 80, required: true },
  { key: 'hospitalSub', group: 'identity', type: 'text', label: 'السطر تحت الاسم', hint: 'بيظهر في القايمة الجانبية', def: 'نظام إدارة المستشفى', max: 60 },
  { key: 'colorPrimary', group: 'identity', type: 'color', label: 'اللون الأساسي', hint: 'الأزرار والعناوين والطباعة. باقي الدرجات بتتولد منه', def: '#9a0000' },
  { key: 'colorAccent', group: 'identity', type: 'color', label: 'اللون المكمّل', hint: 'لمسات خفيفة وخلفيات ناعمة', def: '#ffbd81' },
  { key: 'printFooter', group: 'identity', type: 'text', label: 'تذييل الطباعة', hint: 'عنوان أو تليفون يظهر تحت الإيصالات', def: '', max: 140 },

  // ---- الوقت والورديات ----
  { key: 'tz', group: 'time', type: 'tz', label: 'المنطقة الزمنية', def: 'Africa/Cairo' },
  { key: 'dayStart', group: 'time', type: 'time', label: 'بداية يوم الخزينة', hint: 'اللي قبله بيتحسب على اليوم اللي فات (لحد 12:00)', def: '07:00', max: '12:00' },
  { key: 'shiftAmFrom', group: 'time', type: 'time', label: 'بداية الوردية الأولى', def: '07:00' },
  { key: 'shiftPmFrom', group: 'time', type: 'time', label: 'بداية الوردية الثانية', def: '15:00' },
  { key: 'shiftNightFrom', group: 'time', type: 'time', label: 'بداية الوردية الثالثة', def: '21:00' },
  { key: 'shiftAmName', group: 'time', type: 'text', label: 'اسم الوردية الأولى', def: 'صباحي', max: 20 },
  { key: 'shiftPmName', group: 'time', type: 'text', label: 'اسم الوردية الثانية', def: 'مسائي', max: 20 },
  { key: 'shiftNightName', group: 'time', type: 'text', label: 'اسم الوردية الثالثة', def: 'سهر', max: 20 },
  { key: 'dutyHours', group: 'time', type: 'number', label: 'الخزينة تعتبر شغالة لمدة (ساعات)', hint: 'بعد فتح الوردية', def: '18', min: 1, max: 48 },

  // ---- الخزينة ----
  { key: 'cashierMode', group: 'cashier', type: 'select', label: 'طريقة التحصيل', def: 'auto',
    options: [['auto', 'الاستقبال يعمل إذن دفع والخزينة تقبض (لو فيه خزينة شغالة)'], ['off', 'الاستقبال يقبض بنفسه دايمًا']] },
  { key: 'manualNoRequired', group: 'cashier', type: 'bool', label: 'رقم الإيصال اليدوي إجباري', on: '1', off: '0', def: '0' },

  // ---- الإقامة ----
  { key: 'dxRequired', group: 'inpatient', type: 'bool', label: 'التشخيص إجباري عند دخول الإقامة', on: '1', off: '0', def: '1' },
  { key: 'dxProvisional', group: 'inpatient', type: 'bool', label: 'السماح بتشخيص مبدئي (طوارئ حرجة)', on: '1', off: '0', def: '1' },
  { key: 'dxProvisionalHours', group: 'inpatient', type: 'number', label: 'مهلة تحويل المبدئي لنهائي (بالساعات)', hint: 'بعدها بيظهر تنبيه أحمر والخروج بيتمنع لحد ما يتحدد تشخيص نهائي', def: '24', min: 1, max: 168, int: true },
  { key: 'checkoutTime', group: 'inpatient', type: 'time', label: 'ميعاد حساب يوم الخروج', hint: 'الخروج بعده بيتحسب يوم زيادة', def: '12:00' },

  // ---- المعمل والأشعة ----
  { key: 'labVerify', group: 'lab', type: 'bool', label: 'نتايج المعمل تتراجع قبل التسليم', on: '1', off: '0', def: '0' },

  // ---- التذاكر والمخازن ----
  { key: 'ticketMode', group: 'stock', type: 'bool', label: 'نظام التذكرة في حسابات الإقامة', on: 'on', off: 'off', def: 'on' },
  { key: 'stockDeduct', group: 'stock', type: 'bool', label: 'خصم المخزن عند تسجيل التذكرة', on: 'on', off: 'off', def: 'on' },

  // ---- الحسابات العامة ----
  { key: 'doctorTaxPct', group: 'finance', type: 'number', label: 'ضريبة مستحقات الدكاترة %', def: '5', min: 0, max: 99, step: 0.5 },
  { key: 'payoutApproval', group: 'finance', type: 'bool', label: 'مستحقات الأطباء محتاجة اعتماد المدير المالي قبل الصرف', on: 'on', off: 'off', def: 'on' },
  { key: 'payoutDay', group: 'finance', type: 'number', label: 'يوم صرف مستحقات الدكاترة من الشهر', def: '10', min: 1, max: 28, int: true },

  // ---- الأقسام المفعّلة ----
  { key: 'modLab', group: 'modules', type: 'bool', label: 'المعمل والأشعة', on: '1', off: '0', def: '1' },
  { key: 'modPharmacy', group: 'modules', type: 'bool', label: 'الصيدلية', on: '1', off: '0', def: '1' },
  { key: 'modContracts', group: 'modules', type: 'bool', label: 'التعاقدات والمطالبات', on: '1', off: '0', def: '1' },
  { key: 'modInpatient', group: 'modules', type: 'bool', label: 'الإقامة والأسرّة', on: '1', off: '0', def: '1' },

  // ---- العملة ----
  // الكود وعدد الخانات بيتقفلوا بعد أول معاملة مالية (انظر LOCKED_AFTER_FINANCIAL). 3 خانات (KWD/BHD/OMR) مرفوضة لحد ما أعمدة المبالغ تتوسّع (R1c)
  { key: 'currencyCode', group: 'currency', type: 'text', label: 'كود العملة', hint: 'كود ISO من 3 حروف زي EGP أو USD', def: 'EGP', max: 3, upper: true, required: true },
  { key: 'currencyDecimals', group: 'currency', type: 'select', label: 'عدد خانات العملة', def: '2',
    options: [['2', 'خانتين (جنيه وقرش) — الشائع'], ['0', 'بدون كسور']] },
  { key: 'currencySymbol', group: 'currency', type: 'text', label: 'رمز العملة', hint: 'بيظهر جنب الأرقام', def: 'ج', max: 8, required: true },
  { key: 'currencyPos', group: 'currency', type: 'select', label: 'مكان الرمز', def: 'after',
    options: [['after', 'بعد الرقم (100 ج)'], ['before', 'قبل الرقم (ج 100)']] },
];

// ---- حقول المريض: لكل سياق (عيادات / طوارئ / إقامة) إجباري أو اختياري. الافتراضي = الوضع القديم بالظبط ----
export const PF_CONTEXTS = [['Clinic', 'clinic', 'العيادات'], ['Er', 'er', 'الطوارئ'], ['Adm', 'adm', 'الإقامة']];
export const PF_FIELDS = [['Nid', 'nid', 'الرقم القومي'], ['Phone', 'phone', 'التليفون'], ['Age', 'age', 'السن أو تاريخ الميلاد'], ['Sex', 'sex', 'النوع']];
// الافتراضي (عيادات / طوارئ / إقامة). التليفون في الإقامة إجباري ومقفول (مش في السجل)
const PF_DEF = { Nid: ['opt', 'opt', 'req'], Phone: ['req', 'opt', null], Age: ['req', 'opt', 'opt'], Sex: ['req', 'opt', 'opt'] };
const PF_WORDS_DEF = ['3', '1', '1'];
for (const [i, [C]] of PF_CONTEXTS.entries()) {
  for (const [F, , FN] of PF_FIELDS) {
    const d = PF_DEF[F][i]; if (d == null) continue;
    REGISTRY.push({ key: `pf${F}${C}`, group: 'patient', type: 'select', label: FN, def: d, options: [['req', 'إجباري'], ['opt', 'اختياري']] });
  }
  REGISTRY.push({ key: `pfWords${C}`, group: 'patient', type: 'select', label: 'الاسم', def: PF_WORDS_DEF[i], options: [['1', 'أي اسم'], ['2', 'ثنائي'], ['3', 'ثلاثي'], ['4', 'رباعي']] });
}

/** إعدادات بتتقفل بعد أول معاملة مالية (تغييرها بيخلّي المبالغ المخزنة تتفسّر غلط) */
export const LOCKED_AFTER_FINANCIAL = ['currencyCode', 'currencyDecimals'];
export const CURRENCY_KEYS = { code: 'currencyCode', decimals: 'currencyDecimals', symbol: 'currencySymbol', symbolPos: 'currencyPos' };

export const BY_KEY = Object.fromEntries(REGISTRY.map((s) => [s.key, s]));

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const mins = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

export function validTz(v) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return typeof v === 'string' && v.length > 0; } catch { return false; }
}

/** يحوّل قيمة جاية من الشاشة لقيمة التخزين، أو يرجّع { error } */
export function normalize(def, v) {
  switch (def.type) {
    case 'text': {
      let s = String(v ?? '').replace(/\s+/g, ' ').trim();
      if (def.upper) s = s.toUpperCase();
      if (def.required && !s) return { error: 'مطلوب' };
      if (s.length > (def.max || 200)) return { error: `أقصى طول ${def.max || 200} حرف` };
      return { value: s };
    }
    case 'color': {
      const s = String(v ?? '').trim();
      return HEX.test(s) ? { value: s.toLowerCase() } : { error: 'اللون مش صحيح' };
    }
    case 'time': {
      const s = String(v ?? '').trim();
      if (!HHMM.test(s)) return { error: 'اكتب الوقت زي 07:00' };
      if (def.max && mins(s) > mins(def.max)) return { error: `لحد ${def.max} بس` };
      return { value: s };
    }
    case 'number': {
      const n = Number(String(v ?? '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632));
      if (!Number.isFinite(n)) return { error: 'رقم مش صحيح' };
      if (def.int && !Number.isInteger(n)) return { error: 'رقم صحيح بس' };
      if (def.min != null && n < def.min) return { error: `أقل قيمة ${def.min}` };
      if (def.max != null && n > def.max) return { error: `أقصى قيمة ${def.max}` };
      return { value: String(n) };
    }
    case 'select': {
      const ok = def.options.some((o) => o[0] === v);
      return ok ? { value: v } : { error: 'اختيار غير صحيح' };
    }
    case 'bool': {
      const on = v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
      return { value: on ? def.on : def.off };
    }
    case 'tz':
      return validTz(v) ? { value: String(v) } : { error: 'منطقة زمنية مش معروفة' };
    default:
      return { error: 'نوع غير معروف' };
  }
}

/** فحوصات بين الإعدادات بعضها (ترتيب الورديات مثلًا) */
export function crossCheck(all, { schemaScale } = {}) {
  const errors = {};
  const cur = checkCurrency({ code: all.currencyCode, decimals: all.currencyDecimals, symbol: all.currencySymbol, symbolPos: all.currencyPos }, schemaScale == null ? undefined : { schemaScale });
  for (const [f, msg] of Object.entries(cur.errors || {})) errors[CURRENCY_KEYS[f]] = msg;
  const a = mins(all.shiftAmFrom), p = mins(all.shiftPmFrom), n = mins(all.shiftNightFrom);
  if (!(a < p && p < n)) errors.shiftPmFrom = 'الورديات لازم تترتب خلال اليوم: الأولى قبل الثانية قبل الثالثة';
  const names = [all.shiftAmName, all.shiftPmName, all.shiftNightName];
  if (new Set(names).size !== 3) errors.shiftAmName = 'أسماء الورديات لازم تختلف عن بعض';
  return errors;
}

/** القيمة للعرض: المخزنة أو الافتراضي */
export function toView(def, stored) {
  const raw = stored ?? def.def;
  if (def.type === 'bool') return raw === def.on;
  return raw;
}
