// التحقق من الرقم القومي المصري (14 رقم) واستخراج تاريخ الميلاد والنوع والمحافظة
import { onlyDigits } from './text.js';

export const GOVERNORATES = {
  '01': 'القاهرة', '02': 'الإسكندرية', '03': 'بورسعيد', '04': 'السويس',
  '11': 'دمياط', '12': 'الدقهلية', '13': 'الشرقية', '14': 'القليوبية',
  '15': 'كفر الشيخ', '16': 'الغربية', '17': 'المنوفية', '18': 'البحيرة',
  '19': 'الإسماعيلية', '21': 'الجيزة', '22': 'بني سويف', '23': 'الفيوم',
  '24': 'المنيا', '25': 'أسيوط', '26': 'سوهاج', '27': 'قنا', '28': 'أسوان',
  '29': 'الأقصر', '31': 'البحر الأحمر', '32': 'الوادي الجديد', '33': 'مطروح',
  '34': 'شمال سيناء', '35': 'جنوب سيناء', '88': 'خارج الجمهورية'
};

/**
 * @returns {{ok:true, birthDate:string, sex:'M'|'F', governorate:string} | {ok:false, error:string}}
 */
export function parseNationalId(input, today = new Date()) {
  const n = onlyDigits(input);
  if (n.length !== 14) return { ok: false, error: 'الرقم القومي لازم يكون 14 رقم' };
  const century = n[0] === '2' ? 1900 : n[0] === '3' ? 2000 : null;
  if (!century) return { ok: false, error: 'أول رقم في الرقم القومي لازم يكون 2 أو 3' };
  const y = century + Number(n.slice(1, 3));
  const m = Number(n.slice(3, 5));
  const d = Number(n.slice(5, 7));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: 'تاريخ الميلاد اللي جوه الرقم القومي مش صحيح' };
  }
  if (dt.getTime() > today.getTime()) return { ok: false, error: 'تاريخ الميلاد في الرقم القومي في المستقبل' };
  const gov = n.slice(7, 9);
  if (!GOVERNORATES[gov]) return { ok: false, error: 'كود المحافظة في الرقم القومي مش معروف' };
  const sex = Number(n[12]) % 2 === 1 ? 'M' : 'F';
  const birthDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ok: true, birthDate, sex, governorate: GOVERNORATES[gov], value: n };
}

/** السن بالسنين من تاريخ ميلاد YYYY-MM-DD */
export function ageFromBirthDate(birthDate, today = new Date()) {
  if (!birthDate) return null;
  const [y, m, d] = String(birthDate).slice(0, 10).split('-').map(Number);
  let age = today.getFullYear() - y;
  const mm = today.getMonth() + 1;
  if (mm < m || (mm === m && today.getDate() < d)) age--;
  return age;
}

/** نص السن للعرض: للأطفال بالشهور */
export function ageText(birthDate, ageYears, ageRecordedAt, today = new Date()) {
  if (birthDate) {
    const [y, m, d] = String(birthDate).slice(0, 10).split('-').map(Number);
    let months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m);
    if (today.getDate() < d) months--;
    if (months < 0) return '';
    if (months < 1) {
      const days = Math.max(0, Math.floor((today - new Date(y, m - 1, d)) / 86400000));
      return days + ' يوم';
    }
    if (months < 24) return months + ' شهر';
    return Math.floor(months / 12) + ' سنة';
  }
  if (ageYears != null) {
    let a = Number(ageYears);
    if (ageRecordedAt) {
      const extra = Math.floor((today - new Date(ageRecordedAt)) / (365.25 * 86400000));
      if (extra > 0) a += extra;
    }
    return a + ' سنة';
  }
  return '';
}
