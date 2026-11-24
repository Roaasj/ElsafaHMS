// تفقيط المبالغ بالعربي: 1250.50 => "ألف ومائتان وخمسون جنيهًا وخمسون قرشًا"

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة',
  'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100, parts = [];
  if (h) parts.push(HUNDREDS[h]);
  if (r) {
    if (r < 20) parts.push(ONES[r]);
    else {
      const o = r % 10, t = Math.floor(r / 10);
      parts.push(o ? ONES[o] + ' و' + TENS[t] : TENS[t]);
    }
  }
  return parts.join(' و');
}

function scale(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return below1000(n) + ' ' + few;
  return below1000(n) + ' ' + many;
}

export function numberToArabicWords(num) {
  let n = Math.floor(Math.abs(num));
  if (n === 0) return 'صفر';
  const millions = Math.floor(n / 1e6); n %= 1e6;
  const thousands = Math.floor(n / 1000); const rest = n % 1000;
  const parts = [];
  if (millions) parts.push(scale(millions, 'مليون', 'مليونان', 'ملايين', 'مليون'));
  if (thousands) parts.push(scale(thousands, 'ألف', 'ألفان', 'آلاف', 'ألف'));
  if (rest) parts.push(below1000(rest));
  return parts.join(' و');
}

function unit(n, one, two, plural, single) {
  if (n === 1) return one;
  if (n === 2) return two;
  const r = n % 100;
  if (r >= 3 && r <= 10) return numberToArabicWords(n) + ' ' + plural;
  // مائة جنيه / ألف جنيه (مضاف إليه) ، خمسون جنيهًا (تمييز)
  if (r === 0 || r === 1 || r === 2) return numberToArabicWords(n) + ' ' + single.replace(/ًا$/, '');
  return numberToArabicWords(n) + ' ' + single;
}

/** المبلغ بالقروش (عدد صحيح) */
export function amountInWords(cents) {
  const c = Math.round(Math.abs(cents));
  const pounds = Math.floor(c / 100), pia = c % 100;
  const parts = [];
  if (pounds) parts.push(unit(pounds, 'جنيه واحد', 'جنيهان', 'جنيهات', 'جنيهًا'));
  if (pia) parts.push(unit(pia, 'قرش واحد', 'قرشان', 'قروش', 'قرشًا'));
  if (!parts.length) return 'صفر جنيه';
  return 'فقط ' + parts.join(' و') + ' لا غير';
}
