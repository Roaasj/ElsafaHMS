// الأرقام العشرية بين الكود وSQL Server — أنواع صريحة بدقة معروفة قبل ما أي قيمة تتبعت للقاعدة.
//
// المبدأ: الرقم بيتربط بدقته الحقيقية، والعمود هو اللي بيحدد التخزين. ممنوع أي تقريب صامت في الطريق.
//   dec.money(v)  مبلغ     (خانتين حاليًا؛ الخانات بتجي من العملة لما R1c يوسّع الأعمدة)
//   dec.cost(v)   تكلفة وحدة أساسية (4 خانات)
//   dec.pct(v)    نسبة مئوية (خانتين)
//   dec.qty(v)    كمية (خانتين)
// القيمة اللي فيها خانات أكتر من نوعها بترمي DecimalPrecisionError (مش بتتقرّب بهدوء).
// لو عايز تقريب، اطلبه صراحة:  dec.cost(x, { round: true })  (نص لفوق بنفس صيغة الكود: Math.round).

export class DecimalPrecisionError extends Error {
  constructor(msg) { super(msg); this.name = 'DecimalPrecisionError'; }
}

/** أنواع القيم. scale = عدد الخانات المسموحة. precision للباراميتر (أوسع من أي عمود: DECIMAL(12..14,..)) */
export const KINDS = Object.freeze({
  money: Object.freeze({ scale: 2, precision: 19, label: 'مبلغ' }),
  cost: Object.freeze({ scale: 4, precision: 19, label: 'تكلفة' }),
  pct: Object.freeze({ scale: 2, precision: 19, label: 'نسبة' }),
  qty: Object.freeze({ scale: 2, precision: 19, label: 'كمية' }),
});

/** أكبر عدد صحيح بيمثّله double من غير فقد: tedious بيحسب |v × 10^scale| كرقم JS */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** عدد الخانات العشرية الفعلية في رقم JS (من أقصر تمثيل نصي، بما فيه الصيغة الأسية) */
export function scaleOf(v) {
  if (!Number.isFinite(v)) return NaN;
  const s = String(Math.abs(v));
  const [m, e] = s.split('e');
  const frac = (m.split('.')[1] || '').length;
  return Math.max(0, frac - (e ? Number(e) : 0));
}

export class Dec {
  constructor(kind, value, scale) { this.kind = kind; this.value = value; this.scale = scale; Object.freeze(this); }
  valueOf() { return this.value; }
  toString() { return String(this.value); }
  toJSON() { return this.value; }
}

function make(kind) {
  const k = KINDS[kind];
  return (v, { round = false, scale = k.scale } = {}) => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Dec) { if (v.kind !== kind) throw new DecimalPrecisionError(`قيمة ${KINDS[v.kind].label} اتبعتت مكان ${k.label}`); return v; }
    let n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    if (!Number.isFinite(n)) throw new DecimalPrecisionError(`${k.label}: القيمة مش رقم صحيح (${String(v).slice(0, 30)})`);
    if (scale > k.scale && kind !== 'money') throw new DecimalPrecisionError(`${k.label}: مقياس ${scale} أكبر من المسموح ${k.scale}`);
    if (round) n = Math.round(n * 10 ** scale) / 10 ** scale;
    else if (scaleOf(n) > scale) throw new DecimalPrecisionError(`${k.label}: القيمة ${n} فيها خانات أكتر من ${scale} (هتتقرّب بدون قصد). قرّبها صراحة بـ{ round: true }`);
    if (Math.abs(n) * 10 ** scale > MAX_SAFE) throw new DecimalPrecisionError(`${k.label}: القيمة ${n} أكبر من اللي يتحمّله الربط بدقة ${scale} خانات`);
    return new Dec(kind, n === 0 ? 0 : n, scale); // -0 ← 0
  };
}
export const dec = Object.freeze({ money: make('money'), cost: make('cost'), pct: make('pct'), qty: make('qty') });
export const isDec = (v) => v instanceof Dec;
/** القيمة الخام (لـSQLite أو أي مكان محتاج رقم عادي) */
export const plain = (v) => (v instanceof Dec ? v.value : v);

/**
 * وصف ربط رقم عادي (من غير نوع صريح): { kind: 'int' | 'decimal', precision, scale }.
 * - صحيح داخل int32 ← Int. صحيح أكبر ← Decimal(19,0).
 * - كسري ← Decimal(19, s) بالمقياس الفعلي بحد أقصى آمن لـtedious. الأرقام الكسرية العادية (من غير نوع) ممكن تتقرّب عند العمود بس.
 * strict (DB_STRICT_DECIMAL=1): رقم كسري فيه ضجيج فاصلة عائمة (أكتر من 8 خانات) بيرمي بدل ما يعدّي.
 */
export function describeNumber(v, { strict = false } = {}) {
  if (!Number.isFinite(v)) throw new DecimalPrecisionError('رقم مش صحيح (NaN/Infinity) اتبعت للقاعدة');
  if (Number.isInteger(v)) return Math.abs(v) <= 2147483647 ? { kind: 'int' } : { kind: 'decimal', precision: 19, scale: 0 };
  let s = scaleOf(v);
  if (strict && s > 8) throw new DecimalPrecisionError(`رقم كسري بدون نوع وفيه ${s} خانة (${v}). استخدم dec.money/cost/pct/qty أو قرّبه`);
  const maxSafe = Math.max(0, Math.floor(Math.log10(MAX_SAFE / Math.abs(v))));
  s = Math.min(s, maxSafe, 18);
  const intDigits = Math.max(1, Math.floor(Math.log10(Math.abs(v))) + 1);
  return { kind: 'decimal', precision: intDigits + s <= 19 ? 19 : 38, scale: s };
}
