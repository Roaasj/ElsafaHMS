// أدوات نصوص مشتركة بين السيرفر والواجهة (ES module)

const AR_DIGITS = /[٠-٩]/g;
const FA_DIGITS = /[۰-۹]/g;

/** تحويل الأرقام العربية/الفارسية إلى أرقام لاتينية */
export function latinDigits(s) {
  return String(s ?? '')
    .replace(AR_DIGITS, (d) => String(d.charCodeAt(0) - 1632))
    .replace(FA_DIGITS, (d) => String(d.charCodeAt(0) - 1776));
}

/** مفتاح بحث عربي: بدون تشكيل، توحيد الألف والياء والتاء المربوطة */
export function searchKey(s) {
  return latinDigits(s)
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** الأرقام فقط */
export function onlyDigits(s) {
  return latinDigits(s).replace(/\D/g, '');
}

/** توحيد رقم التليفون: +20 أو 0020 تتحول لصفر */
export function normalizePhone(s) {
  let d = onlyDigits(s);
  if (d.startsWith('0020')) d = '0' + d.slice(4);
  else if (d.startsWith('20') && d.length === 12) d = '0' + d.slice(2);
  return d;
}

export function isValidPhone(s) {
  const d = normalizePhone(s);
  if (/^01[0125]\d{8}$/.test(d)) return true; // موبايل مصري
  return /^0\d{7,9}$/.test(d); // أرضي
}

/** تنظيف الاسم: مسافات زيادة */
export function cleanName(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function nameParts(s) {
  return cleanName(s).split(' ').filter(Boolean).length;
}
