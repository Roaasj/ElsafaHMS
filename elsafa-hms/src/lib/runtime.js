// الإعدادات اللي لازم تتقري بشكل متزامن (الوقت والورديات والهوية).
// بتتحمّل من AppSettings عند التشغيل وبعد أي حفظ، ومفيش imports هنا عشان نتجنب الدوران.
import { REGISTRY, BY_KEY, PF_CONTEXTS, PF_FIELDS } from './settings-registry.js';
import { makeMoney } from '../../shared/money.js';

const def = (k) => BY_KEY[k].def;
const mins = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

const currencyOf = (g) => ({ code: g('currencyCode'), decimals: Number(g('currencyDecimals')), symbol: g('currencySymbol'), symbolPos: g('currencyPos') });

// حقول المريض لكل سياق: { clinic: { nid, phone, age, sex, words }, er: {...}, adm: {...} }. التليفون في الإقامة إجباري دايمًا
const patientFieldsOf = (g) => Object.fromEntries(PF_CONTEXTS.map(([C, c]) => [c, {
  ...Object.fromEntries(PF_FIELDS.map(([F, f]) => [f, c === 'adm' && f === 'phone' ? 'req' : g(`pf${F}${C}`)])),
  words: Number(g(`pfWords${C}`)),
}]));

export const R = {
  modules: { lab: true, pharmacy: true, contracts: true, inpatient: true },
  dx: { required: true, provisional: true, hours: 24 },
  patientFields: null,
  currency: null, // بيتملّى تحت من الافتراضي، وبعدها من الإعدادات
  money: null,
  tz: def('tz'),
  dayStart: mins(def('dayStart')),
  shifts: { am: mins(def('shiftAmFrom')), pm: mins(def('shiftPmFrom')), night: mins(def('shiftNightFrom')) },
  shiftNames: { am: def('shiftAmName'), pm: def('shiftPmName'), night: def('shiftNightName') },
  dutyHours: Number(def('dutyHours')),
  brand: {
    name: def('hospitalName'), sub: def('hospitalSub'), primary: def('colorPrimary'), accent: def('colorAccent'),
    footer: def('printFooter'), logoVersion: 0,
  },
};

function setCurrency(g) {
  R.dx = { required: g('dxRequired') === '1', provisional: g('dxProvisional') === '1', hours: Number(g('dxProvisionalHours')) };
  R.patientFields = patientFieldsOf(g);
  R.money = makeMoney(currencyOf(g));
  R.currency = R.money.toJSON();
}
setCurrency(def);

export function applyRuntime(v) {
  const g = (k) => v[k] ?? def(k);
  setCurrency(g);
  R.tz = g('tz');
  R.dayStart = mins(g('dayStart'));
  R.shifts = { am: mins(g('shiftAmFrom')), pm: mins(g('shiftPmFrom')), night: mins(g('shiftNightFrom')) };
  R.shiftNames = { am: g('shiftAmName'), pm: g('shiftPmName'), night: g('shiftNightName') };
  R.dutyHours = Number(g('dutyHours')) || 18;
  R.modules = { lab: g('modLab') !== '0', pharmacy: g('modPharmacy') !== '0', contracts: g('modContracts') !== '0', inpatient: g('modInpatient') !== '0' };
  R.brand = {
    ...R.brand,
    name: g('hospitalName'), sub: g('hospitalSub'), primary: g('colorPrimary'), accent: g('colorAccent'), footer: g('printFooter'),
  };
}

/** كل القيم المخزنة (الافتراضي لو ما اتخزنتش) */
export async function readSettings(db) {
  const rows = await db.query('SELECT [Key] AS K, Value FROM AppSettings');
  const out = {};
  for (const r of rows) out[r.K] = r.Value;
  return out;
}

export async function loadRuntime(db) {
  applyRuntime(await readSettings(db));
  return R;
}

export const settingKeys = REGISTRY.map((s) => s.key);

/** لون الهوية بصيغة ARGB للإكسل */
export const argb = () => 'FF' + R.brand.primary.slice(1).toUpperCase();
