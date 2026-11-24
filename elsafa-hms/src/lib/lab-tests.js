// تحاليل المعمل الافتراضية: بنودها ووحداتها والمعدلات الطبيعية (للكبار، ولبعضها للأطفال)
import { deptSql } from './lookups.js';
// ⚠️ المعدلات دي قيم مرجعية شائعة كبداية، ولازم دكتور المعمل يراجعها ويظبطها على أجهزة وكواشف المعمل قبل التشغيل
// النطاق: { s: 'M'|'F'|'' , a0: من سن (سنين), a1: لحد سن (مش شامل), lo, hi }  — lo أو hi ممكن يبقى null

const R = (lo, hi, s = '', a0 = null, a1 = null) => ({ s, a0, a1, lo, hi });
const num = (name, unit, ranges, decimals = 1, refText = null) => ({ name, unit, kind: 'num', ranges, decimals, refText });
const sel = (name, options, normal, refText = null) => ({ name, kind: 'select', options, normal, refText: refText ?? normal });
const txt = (name, refText = null) => ({ name, kind: 'text', refText });
const hdr = (name) => ({ name, kind: 'header' });
const NEG = 'Negative|Positive';
const NIL = 'Nil|Trace|+|++|+++';

export const DEFAULT_LAB_TESTS = [
  { code: 'CBC', name: 'Complete Blood Count (CBC)', ar: 'صورة دم كاملة', kw: 'صورة دم|cbc', section: 'hematology', sample: 'blood', tube: 'EDTA', hours: 2, params: [
    num('Hemoglobin', 'g/dL', [R(11.0, 14.5, '', 0, 12), R(13.5, 17.5, 'M'), R(12.0, 15.5, 'F')]),
    num('RBCs', 'x10⁶/µL', [R(4.0, 5.2, '', 0, 12), R(4.5, 5.9, 'M'), R(4.0, 5.2, 'F')], 2),
    num('Hematocrit (HCT)', '%', [R(33, 43, '', 0, 12), R(41, 53, 'M'), R(36, 46, 'F')]),
    num('MCV', 'fL', [R(75, 95, '', 0, 12), R(80, 100)]),
    num('MCH', 'pg', [R(25, 33, '', 0, 12), R(27, 33)]),
    num('MCHC', 'g/dL', [R(32, 36)]),
    num('RDW', '%', [R(11.5, 14.5)]),
    num('WBCs', 'x10³/µL', [R(5.0, 14.5, '', 0, 12), R(4.0, 11.0)]),
    hdr('Differential count'),
    num('Neutrophils', '%', [R(40, 75)], 0),
    num('Lymphocytes', '%', [R(20, 45)], 0),
    num('Monocytes', '%', [R(2, 10)], 0),
    num('Eosinophils', '%', [R(1, 6)], 0),
    num('Basophils', '%', [R(0, 1)], 0),
    num('Platelets', 'x10³/µL', [R(150, 450)], 0),
  ] },
  { code: 'ESR', name: 'ESR', ar: 'سرعة ترسيب', kw: 'ترسيب|esr', section: 'hematology', sample: 'blood', tube: 'Citrate', hours: 2, params: [
    num('ESR (1st hour)', 'mm/hr', [R(0, 15, 'M'), R(0, 20, 'F')], 0),
  ] },
  { code: 'FBS', name: 'Fasting Blood Sugar', ar: 'سكر صائم', kw: 'سكر صائم|fbs', section: 'chemistry', sample: 'serum', tube: 'Fluoride', hours: 1, params: [
    num('Fasting blood glucose', 'mg/dL', [R(70, 100)], 0),
  ] },
  { code: 'RBS', name: 'Random Blood Sugar', ar: 'سكر عشوائي', kw: 'سكر عشوائي|سكر فاطر|rbs', section: 'chemistry', sample: 'serum', tube: 'Fluoride', hours: 1, params: [
    num('Random blood glucose', 'mg/dL', [R(70, 140)], 0),
  ] },
  { code: 'PPBS', name: '2 Hours Post-Prandial Blood Sugar', ar: 'سكر بعد الأكل بساعتين', kw: 'بعد الأكل|ppbs', section: 'chemistry', sample: 'serum', tube: 'Fluoride', hours: 1, params: [
    num('2h post-prandial glucose', 'mg/dL', [R(null, 140)], 0, '< 140'),
  ] },
  { code: 'HBA1C', name: 'Glycated Hemoglobin (HbA1c)', ar: 'سكر تراكمي', kw: 'تراكمي|hba1c', section: 'chemistry', sample: 'blood', tube: 'EDTA', hours: 4, params: [
    num('HbA1c', '%', [R(4.0, 5.6)], 1, 'Normal < 5.7 · Prediabetes 5.7–6.4 · Diabetes ≥ 6.5'),
  ] },
  { code: 'LFT', name: 'Liver Function Tests', ar: 'وظائف كبد', kw: 'وظائف كبد|lft', section: 'chemistry', sample: 'serum', tube: 'Plain', hours: 3, params: [
    num('ALT (SGPT)', 'U/L', [R(0, 41, 'M'), R(0, 33, 'F')], 0),
    num('AST (SGOT)', 'U/L', [R(0, 40, 'M'), R(0, 32, 'F')], 0),
    num('Alkaline phosphatase', 'U/L', [R(40, 129, 'M'), R(35, 104, 'F')], 0),
    num('Total bilirubin', 'mg/dL', [R(0.3, 1.2)]),
    num('Direct bilirubin', 'mg/dL', [R(0, 0.3)], 2),
    num('Total protein', 'g/dL', [R(6.0, 8.3)]),
    num('Albumin', 'g/dL', [R(3.5, 5.0)]),
  ] },
  { code: 'KFT', name: 'Kidney Function Tests', ar: 'وظائف كلى', kw: 'وظائف كلى|kft|rft', section: 'chemistry', sample: 'serum', tube: 'Plain', hours: 3, params: [
    num('Urea', 'mg/dL', [R(15, 45)], 0),
    num('Creatinine', 'mg/dL', [R(0.3, 0.7, '', 0, 12), R(0.7, 1.3, 'M'), R(0.6, 1.1, 'F')], 2),
    num('Uric acid', 'mg/dL', [R(3.4, 7.0, 'M'), R(2.4, 6.0, 'F')]),
  ] },
  { code: 'LIPID', name: 'Lipid Profile', ar: 'صورة دهون', kw: 'دهون|lipid', section: 'chemistry', sample: 'serum', tube: 'Plain', hours: 3, params: [
    num('Total cholesterol', 'mg/dL', [R(null, 200)], 0, 'Desirable < 200'),
    num('Triglycerides', 'mg/dL', [R(null, 150)], 0, 'Normal < 150'),
    num('HDL cholesterol', 'mg/dL', [R(40, null, 'M'), R(50, null, 'F')], 0),
    num('LDL cholesterol', 'mg/dL', [R(null, 100)], 0, 'Optimal < 100'),
  ] },
  { code: 'ELEC', name: 'Electrolytes', ar: 'أملاح (صوديوم وبوتاسيوم)', kw: 'صوديوم|بوتاسيوم|أملاح|electrolyte', section: 'chemistry', sample: 'serum', tube: 'Plain', hours: 2, params: [
    num('Sodium (Na)', 'mmol/L', [R(135, 145)], 0),
    num('Potassium (K)', 'mmol/L', [R(3.5, 5.1)]),
  ] },
  { code: 'CA', name: 'Serum Calcium', ar: 'كالسيوم', kw: 'كالسيوم|calcium', section: 'chemistry', sample: 'serum', tube: 'Plain', hours: 3, params: [
    num('Total calcium', 'mg/dL', [R(8.5, 10.5)]),
  ] },
  { code: 'CRP', name: 'C-Reactive Protein (CRP)', ar: 'سي آر بي', kw: 'crp|سي ار بي|سي آر بي', section: 'serology', sample: 'serum', tube: 'Plain', hours: 2, params: [
    num('CRP', 'mg/L', [R(0, 5)]),
  ] },
  { code: 'ASOT', name: 'ASO Titre', ar: 'أسو', kw: 'aso|أسو|اسو', section: 'serology', sample: 'serum', tube: 'Plain', hours: 3, params: [
    num('ASO titre', 'IU/mL', [R(null, 200)], 0, '< 200'),
  ] },
  { code: 'RF', name: 'Rheumatoid Factor (RF)', ar: 'روماتويد', kw: 'روماتويد|rf', section: 'serology', sample: 'serum', tube: 'Plain', hours: 3, params: [
    num('RF', 'IU/mL', [R(null, 14)], 0, '< 14'),
  ] },
  { code: 'TSH', name: 'Thyroid Stimulating Hormone (TSH)', ar: 'هرمون الغدة', kw: 'tsh|غدة|درقية', section: 'hormones', sample: 'serum', tube: 'Plain', hours: 6, params: [
    num('TSH', 'µIU/mL', [R(0.4, 4.0)], 2),
  ] },
  { code: 'FT4', name: 'Free T4', ar: 'إف تي 4', kw: 'ft4|free t4', section: 'hormones', sample: 'serum', tube: 'Plain', hours: 6, params: [
    num('Free T4', 'ng/dL', [R(0.8, 1.8)], 2),
  ] },
  { code: 'VITD', name: 'Vitamin D (25-OH)', ar: 'فيتامين د', kw: 'فيتامين د|vitamin d|vit d', section: 'hormones', sample: 'serum', tube: 'Plain', hours: 24, params: [
    num('25-OH Vitamin D', 'ng/mL', [R(30, 100)], 1, 'Deficient < 20 · Insufficient 20–29 · Sufficient 30–100'),
  ] },
  { code: 'FERR', name: 'Serum Ferritin', ar: 'مخزون حديد', kw: 'فيريتين|مخزون الحديد|مخزون حديد|ferritin', section: 'hormones', sample: 'serum', tube: 'Plain', hours: 24, params: [
    num('Ferritin', 'ng/mL', [R(24, 336, 'M'), R(11, 307, 'F')], 0),
  ] },
  { code: 'BHCG', name: 'Serum β-hCG (Quantitative)', ar: 'تحليل حمل في الدم', kw: 'حمل في الدم|hcg', section: 'hormones', sample: 'serum', tube: 'Plain', hours: 4, params: [
    num('β-hCG', 'mIU/mL', [], 1, 'Non-pregnant < 5'),
  ] },
  { code: 'PREG', name: 'Urine Pregnancy Test', ar: 'تحليل حمل بول', kw: 'حمل بول|حمل في البول|pregnancy', section: 'urine', sample: 'urine', hours: 1, params: [
    sel('Pregnancy test (urine hCG)', NEG, null, ''),
  ] },
  { code: 'PT', name: 'Prothrombin Time (PT/INR)', ar: 'سيولة', kw: 'سيولة|pt|inr', section: 'coagulation', sample: 'blood', tube: 'Citrate', hours: 2, params: [
    num('Prothrombin time', 'sec', [R(11.0, 13.5)]),
    num('Control', 'sec', [], 1, ''),
    num('INR', '', [R(0.8, 1.2)], 2),
    num('PTT', 'sec', [R(25, 35)]),
  ] },
  { code: 'HCV', name: 'HCV Antibody', ar: 'فيروس سي', kw: 'فيروس سي|hcv', section: 'serology', sample: 'serum', tube: 'Plain', hours: 3, params: [
    sel('HCV Ab', NEG, 'Negative'),
  ] },
  { code: 'HBSAG', name: 'HBs Antigen', ar: 'فيروس بي', kw: 'فيروس بي|hbsag', section: 'serology', sample: 'serum', tube: 'Plain', hours: 3, params: [
    sel('HBsAg', NEG, 'Negative'),
  ] },
  { code: 'BG', name: 'Blood Group', ar: 'فصيلة دم', kw: 'فصيلة|blood group', section: 'hematology', sample: 'blood', tube: 'EDTA', hours: 1, params: [
    sel('ABO group', 'A|B|AB|O', null, ''),
    sel('Rh (D)', 'Positive|Negative', null, ''),
  ] },
  { code: 'URINE', name: 'Complete Urine Analysis', ar: 'تحليل بول كامل', kw: 'بول كامل|urine analysis', section: 'urine', sample: 'urine', hours: 2, params: [
    hdr('Physical examination'),
    sel('Color', 'Yellow|Pale yellow|Amber|Red|Brown', 'Yellow'),
    sel('Appearance', 'Clear|Slightly turbid|Turbid', 'Clear'),
    num('Specific gravity', '', [R(1.005, 1.030)], 3),
    num('pH', '', [R(4.5, 8.0)]),
    hdr('Chemical examination'),
    sel('Protein', NIL, 'Nil'), sel('Glucose', NIL, 'Nil'), sel('Ketones', NIL, 'Nil'), sel('Blood', NIL, 'Nil'),
    hdr('Microscopic examination'),
    txt('Pus cells', '0 – 5 /HPF'), txt('RBCs', '0 – 2 /HPF'), sel('Epithelial cells', 'Few|Moderate|Many', 'Few'),
    sel('Crystals', 'Nil|Calcium oxalate|Uric acid|Amorphous urates|Amorphous phosphates|Triple phosphate', 'Nil'),
    sel('Casts', 'Nil|Hyaline|Granular|RBC casts|WBC casts', 'Nil'), sel('Bacteria', 'Nil|Few|Moderate|Many', 'Nil'),
  ] },
  { code: 'STOOL', name: 'Stool Analysis', ar: 'تحليل براز', kw: 'براز|stool', section: 'stool', sample: 'stool', hours: 2, params: [
    sel('Color', 'Brown|Yellow|Green|Black|Red', 'Brown'),
    sel('Consistency', 'Formed|Semi-formed|Soft|Loose|Watery', 'Formed'),
    sel('Mucus', 'Nil|+|++|+++', 'Nil'), sel('Blood', 'Nil|+|++|+++', 'Nil'),
    hdr('Microscopic examination'),
    txt('Ova', 'Not detected'), txt('Cysts', 'Not detected'), txt('Pus cells', '0 – 2 /HPF'), txt('RBCs', '0 – 1 /HPF'),
  ] },
  { code: 'HPYAG', name: 'H. pylori Antigen in Stool', ar: 'جرثومة المعدة في البراز', kw: 'جرثومة|pylori', section: 'stool', sample: 'stool', hours: 3, params: [
    sel('H. pylori stool antigen', NEG, 'Negative'),
  ] },
];

/** يربط خدمات المعمل اللي مش مربوطة بالتحاليل حسب الكلمات */
export async function linkLabServices(db) {
  const tests = await db.query('SELECT Id, Keywords FROM LabTests WHERE Active = 1 AND Keywords IS NOT NULL ORDER BY SortOrder');
  const services = await db.query("SELECT s.Id, s.Name FROM Services s WHERE s.Dept = 'lab' AND NOT EXISTS (SELECT 1 FROM LabTests t WHERE t.ServiceId = s.Id)");
  let n = 0;
  for (const s of services) {
    const t = tests.find((x) => x.Keywords.split('|').some((k) => k && s.Name.toLowerCase().includes(k.toLowerCase())));
    if (t && !(await db.one('SELECT Id FROM LabTests WHERE Id = ? AND ServiceId IS NOT NULL', [t.Id]))) {
      await db.run('UPDATE LabTests SET ServiceId = ? WHERE Id = ?', [s.Id, t.Id]); n++;
    }
  }
  return n;
}

export async function seedLabTests(db) {
  const c = await db.one('SELECT COUNT(*) AS N FROM LabTests');
  if (Number(c?.N || 0) > 0) return 0;
  let i = 0;
  for (const t of DEFAULT_LAB_TESTS) {
    const id = await db.insert('LabTests', {
      Code: t.code, Name: t.name, ArName: t.ar, ServiceId: null, Keywords: t.kw, Section: t.section, Sample: t.sample, Tube: t.tube || null,
      Hours: t.hours, '[External]': 0, SortOrder: i++, Active: 1, CreatedAt: new Date(),
    });
    let j = 0;
    for (const p of t.params) {
      await db.insert('LabParams', {
        TestId: id, Name: p.name, Unit: p.unit || null, Kind: p.kind, Options: p.options || null, NormalText: p.normal || null,
        Decimals: p.decimals ?? null, Ranges: p.ranges ? JSON.stringify(p.ranges) : null, RefText: p.refText || null, SortOrder: j++, Active: 1,
      });
    }
  }
  await linkLabServices(db);
  return i;
}
