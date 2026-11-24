// منطق المبالغ في مكان واحد (بيشتغل في السيرفر والواجهة، من غير أي import).
//
// الفكرة: المبالغ كلها بتتحسب بالوحدة الصغرى (أعداد صحيحة)، وعامل التحويل F = 10^decimals
// بييجي من إعدادات العملة بدل ما يكون 100 ثابت. مع decimals = 2 كل تعبير هنا هو **حرفيًا** التعبير
// اللي كان في الكود (Math.round(x * 100) وهكذا)، فنتايج الحسابات الحالية ما بتتغيّرش بالبت.
// ممنوع أي «تحسين» للفاصلة العائمة هنا: cents(1.015) = 101 زي ما كانت. الدقة الأحسن قرار محاسبي مستقل.

/** أقصى عدد خانات تدعمه طبقة الحساب والعرض (التخزين بيتحدد من أعمدة القاعدة، انظر MONEY_SCHEMA_SCALE) */
export const MAX_DECIMALS = 3;

/** عدد خانات أعمدة المبالغ في القاعدة حاليًا (DECIMAL(12,2) و(14,2)). بيتوسّع في R1c */
export const MONEY_SCHEMA_SCALE = 2;

export const DEFAULT_CURRENCY = Object.freeze({ code: 'EGP', decimals: 2, symbol: 'ج', symbolPos: 'after' });

const CODE_RE = /^[A-Z]{3}$/;

/** تحقق من إعدادات العملة. بيرجّع { value } أو { errors: { الحقل: رسالة } } */
export function checkCurrency(c, { schemaScale = MONEY_SCHEMA_SCALE } = {}) {
  const errors = {};
  if (!CODE_RE.test(String(c?.code ?? ''))) errors.code = 'كود العملة 3 حروف إنجليزي كبيرة زي EGP';
  const d = Number(c?.decimals);
  if (!Number.isInteger(d) || d < 0 || d > MAX_DECIMALS) errors.decimals = `عدد الخانات من 0 لـ ${MAX_DECIMALS}`;
  else if (d > schemaScale) errors.decimals = `قاعدة البيانات الحالية بتخزّن ${schemaScale} خانات بس. ${d} خانات محتاجة ترقية أعمدة المبالغ الأول`;
  const sym = String(c?.symbol ?? '').trim();
  if (!sym || sym.length > 8) errors.symbol = 'رمز العملة من 1 لـ 8 حروف';
  if (c?.symbolPos !== 'before' && c?.symbolPos !== 'after') errors.symbolPos = 'مكان الرمز قبل أو بعد الرقم';
  if (Object.keys(errors).length) return { errors };
  return { value: { code: c.code, decimals: d, symbol: sym, symbolPos: c.symbolPos } };
}

/**
 * @param {{code?:string, decimals?:number, symbol?:string, symbolPos?:'before'|'after'}} cur
 * @param {{locale?:string}} [opts]
 */
export function makeMoney(cur = DEFAULT_CURRENCY, { locale = 'en-US' } = {}) {
  const { code, decimals, symbol, symbolPos } = { ...DEFAULT_CURRENCY, ...cur };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw new RangeError(`decimals لازم من 0 لـ ${MAX_DECIMALS}`);
  const F = 10 ** decimals;
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: decimals });
  const digitsAr = /[٠-٩]/g;

  /** من قيمة القاعدة (وحدات العملة) للوحدة الصغرى. نفس التعبير الحالي: Math.round(Number(v || 0) * 100) */
  const toMinor = (v) => Math.round(Number(v || 0) * F);
  /** من الوحدة الصغرى لقيمة القاعدة */
  const fromMinor = (m) => Math.round(m) / F;
  /** تقريب قيمة بوحدات العملة لخانات العملة. نفس Math.round(Number(v) * 100) / 100 مع خانتين */
  const round = (v) => Math.round(Number(v) * F) / F;

  /**
   * من إدخال المستخدم (وحدات العملة) للوحدة الصغرى مع التحقق. نفس تحقق parseMoney الحالي.
   * @param {(msg:string)=>Error} fail بيبني الخطأ (السيرفر بيدّي bad)
   */
  function parse(v, label = 'المبلغ', fail = (m) => new Error(m)) {
    if (v === '' || v == null) return 0;
    const n = Number(String(v).replace(digitsAr, (d) => d.charCodeAt(0) - 1632).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) throw fail(`${label} مش رقم صحيح`);
    const c = Math.round(n * F);
    if (Math.abs(n * F - c) > 1e-6) throw fail(`${label} فيه كسور أقل من ${decimals === 2 ? 'قرش' : 'أصغر وحدة للعملة'}`);
    return c;
  }

  /** نسبة من مبلغ (بالوحدة الصغرى) */
  const percent = (minor, pct) => Math.round(minor * pct / 100);
  /** المبلغ بعد خصم نسبة */
  const discount = (minor, pct) => Math.round(minor * (100 - pct) / 100);
  /** نفس discount لكن على قيمة بوحدات العملة (صيغة العميل القديمة: Math.round(v * (100 - pct)) / 100 مع خانتين) */
  /** نسبة من قيمة بوحدات العملة (خصم نسبة جاهزة في الواجهة): Math.round(v * pct) / 100 مع خانتين */
  const percentValue = (v, pct) => Math.round(v * pct * (F / 100)) / F;
  const discountValue = (v, pct) => Math.round(v * (100 - pct) * (F / 100)) / F;

  /** رقم للعرض (قيمة بوحدات العملة): بدون خانات زيادة، وأقصى خانات = decimals. نفس money() الحالية مع decimals = 2 */
  const fmt = (v) => nf.format(Number(v || 0));
  /** نفس fmt لكن من الوحدة الصغرى */
  const fmtMinor = (m) => fmt(fromMinor(m));
  /** من الوحدة الصغرى بعدد خانات ثابت (للطباعة): نفس (c / 100).toLocaleString مع خانتين */
  const nfFixed = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const fmtFixedMinor = (m) => nfFixed.format(m / F);
  /** قيمة بوحدات العملة بعدد خانات ثابت (للطباعة) */
  const fixed = (v) => nfFixed.format(Number(v));
  /** رقم + رمز العملة في مكانه (نص عادي) */
  /** اسم العملة في الرسايل النصية: «جنيه» للمصري، وغير كده الرمز */
  const unitWord = code === 'EGP' ? 'جنيه' : symbol;
  const withSymbol = (v) => (symbolPos === 'before' ? `${symbol} ${fmt(v)}` : `${fmt(v)} ${symbol}`);
  /** تنسيق خلايا الإكسل */
  const xlsxFormat = () => (decimals ? `#,##0.${'0'.repeat(decimals)}` : '#,##0');

  return Object.freeze({ code, decimals, symbol, symbolPos, F, toMinor, fromMinor, round, parse, percent, discount, discountValue, percentValue, fmt, fmtMinor, fmtFixedMinor, fixed, unitWord, withSymbol, xlsxFormat,
    /** الشكل اللي بيتبعت للواجهة */
    toJSON: () => ({ code, decimals, symbol, symbolPos }) });
}

// ---- تقريب القيم غير المبالغ (نفس تعبيرات الكود الحالي، معرّفة في مكان واحد) ----
const roundTo = (n, d) => { const f = 10 ** d; return Math.round(Number(n) * f) / f; };
/** تكلفة وحدة أساسية: 4 خانات */
export const cost4 = (n) => roundTo(n, 4);
/** نسبة مئوية: خانتين (نفس pctVal) */
export const pct2 = (n) => roundTo(n, 2);
/** كمية: خانتين (نفس r2) */
export const qty2 = (n) => roundTo(n, 2);
