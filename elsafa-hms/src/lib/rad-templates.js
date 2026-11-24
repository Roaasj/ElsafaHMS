// قوالب تقارير الأشعة الافتراضية (بتتضاف أول مرة بس لو الجدول فاضي، والمدير/دكتور الأشعة يعدّلها)
// النصوص دي «طبيعي» كبداية، والدكتور بيعدّل اللي يلزم
const p = (label, text) => `<p><b>${label}:</b> ${text}</p>`;

export const DEFAULT_RAD_TEMPLATES = [
  {
    name: 'بطن وحوض (طبيعي)', modality: 'us', title: 'ULTRASOUND ABDOMEN & PELVIS',
    body: [
      p('Liver', 'Normal in size, outline and homogeneous echo pattern. No focal lesions. No dilated intrahepatic biliary radicals.'),
      p('Gall bladder', 'Well distended with normal wall thickness. No stones or sludge.'),
      p('CBD', 'Not dilated.'),
      p('Portal vein', 'Normal in calibre.'),
      p('Pancreas', 'Visualized parts appear normal.'),
      p('Spleen', 'Normal in size and echo pattern.'),
      p('Kidneys', 'Both kidneys are normal in size, shape and position with preserved corticomedullary differentiation. No stones, hydronephrosis or masses.'),
      p('Urinary bladder', 'Well distended with smooth wall. No intraluminal lesions.'),
      p('Others', 'No ascites. No pelvic collections.'),
      '<p><b>IMPRESSION:</b></p><ul><li>Normal abdominal and pelvic ultrasound study.</li></ul>',
    ].join(''),
  },
  {
    name: 'حوض سيدات', modality: 'us', title: 'PELVIC ULTRASOUND (FEMALE)',
    body: [
      p('Uterus', 'Anteverted, normal in size measuring … × … × … cm with homogeneous myometrial echo pattern. No focal lesions.'),
      p('Endometrium', 'Central, measuring … mm.'),
      p('Right ovary', 'Normal in size and echo pattern.'),
      p('Left ovary', 'Normal in size and echo pattern.'),
      p('Others', 'No adnexal masses. No free fluid in Douglas pouch.'),
      '<p><b>IMPRESSION:</b></p><ul><li>Normal pelvic ultrasound study.</li></ul>',
    ].join(''),
  },
  {
    name: 'حمل (الثلث الأول)', modality: 'us', title: 'OBSTETRIC ULTRASOUND — FIRST TRIMESTER',
    body: [
      p('Gestational sac', 'Single intrauterine gestational sac.'),
      p('Embryo', 'Single live embryo with positive cardiac pulsations. FHR … bpm.'),
      p('CRL', '… mm corresponding to … weeks … days.'),
      p('Yolk sac', 'Seen, normal.'),
      p('Adnexa', 'Unremarkable. No free fluid.'),
      '<p><b>IMPRESSION:</b></p><ul><li>Single live intrauterine pregnancy of … weeks … days.</li><li>EDD: …</li></ul>',
    ].join(''),
  },
  {
    name: 'حمل (الثلث التاني والتالت)', modality: 'us', title: 'OBSTETRIC ULTRASOUND',
    body: [
      p('Fetus', 'Single live intrauterine fetus, … presentation. FHR … bpm.'),
      p('Biometry', 'BPD … mm, HC … mm, AC … mm, FL … mm, corresponding to … weeks … days.'),
      p('EFW', '… g.'),
      p('Placenta', '… , grade … , not low lying.'),
      p('Amniotic fluid', 'Adequate (AFI … cm).'),
      '<p><b>IMPRESSION:</b></p><ul><li>Single live intrauterine fetus of … weeks … days by biometry.</li></ul>',
    ].join(''),
  },
  {
    name: 'غدة درقية', modality: 'us', title: 'ULTRASOUND THYROID',
    body: [
      p('Right lobe', 'Normal in size measuring … × … × … cm with homogeneous echo pattern. No nodules.'),
      p('Left lobe', 'Normal in size measuring … × … × … cm with homogeneous echo pattern. No nodules.'),
      p('Isthmus', '… mm, normal.'),
      p('Others', 'Normal vascularity on colour Doppler. No significant cervical lymphadenopathy.'),
      '<p><b>IMPRESSION:</b></p><ul><li>Normal thyroid ultrasound study.</li></ul>',
    ].join(''),
  },
  {
    name: 'ثدي', modality: 'us', title: 'BILATERAL BREAST ULTRASOUND',
    body: [
      p('Right breast', 'Normal fibroglandular tissue. No solid or cystic lesions.'),
      p('Left breast', 'Normal fibroglandular tissue. No solid or cystic lesions.'),
      p('Axillae', 'No significant axillary lymphadenopathy.'),
      '<p><b>IMPRESSION:</b></p><ul><li>No sonographic abnormality. BI-RADS 1.</li></ul>',
    ].join(''),
  },
  {
    name: 'كلى ومسالك', modality: 'us', title: 'ULTRASOUND KUB',
    body: [
      p('Right kidney', 'Normal in size (… cm), shape and position. Preserved parenchymal thickness. No stones or hydronephrosis.'),
      p('Left kidney', 'Normal in size (… cm), shape and position. Preserved parenchymal thickness. No stones or hydronephrosis.'),
      p('Urinary bladder', 'Well distended with smooth wall. No stones.'),
      p('Prostate', '(in males) Normal in size, volume … cc.'),
      '<p><b>IMPRESSION:</b></p><ul><li>Normal KUB ultrasound study.</li></ul>',
    ].join(''),
  },
  {
    name: 'كيس الصفن', modality: 'us', title: 'SCROTAL ULTRASOUND',
    body: [
      p('Right testis', 'Normal in size (… × … cm) and echo pattern. Normal vascularity.'),
      p('Left testis', 'Normal in size (… × … cm) and echo pattern. Normal vascularity.'),
      p('Epididymis', 'Both are normal.'),
      p('Others', 'No hydrocele. No varicocele.'),
      '<p><b>IMPRESSION:</b></p><ul><li>Normal scrotal ultrasound study.</li></ul>',
    ].join(''),
  },
  {
    name: 'أشعة صدر عادية', modality: 'xray', title: 'CHEST X-RAY (PA VIEW)',
    body: [
      p('Lungs', 'Clear lung fields. No focal consolidation, collapse or masses.'),
      p('Pleura', 'Clear costophrenic angles. No pleural effusion or pneumothorax.'),
      p('Heart', 'Normal cardiac size and contour.'),
      p('Mediastinum', 'Central trachea. Normal mediastinal outline.'),
      p('Bones', 'Visualized bony thorax is unremarkable.'),
      '<p><b>IMPRESSION:</b></p><ul><li>No significant radiological abnormality.</li></ul>',
    ].join(''),
  },
  {
    name: 'مقطعية (عام)', modality: 'ct', title: 'CT EXAMINATION',
    body: '<p><b>Technique:</b> …</p><p><b>Findings:</b></p><p>…</p><p><b>IMPRESSION:</b></p><ul><li>…</li></ul>',
  },
  {
    name: 'ماموجرام', modality: 'mammo', title: 'BILATERAL MAMMOGRAPHY',
    body: [
      p('Breast composition', 'ACR category … .'),
      p('Findings', 'No suspicious masses, architectural distortion or suspicious microcalcifications.'),
      p('Axillae', 'Unremarkable.'),
      '<p><b>IMPRESSION:</b></p><ul><li>BI-RADS 1 — negative.</li></ul>',
    ].join(''),
  },
];

export async function seedRadTemplates(db) {
  const n = await db.one('SELECT COUNT(*) AS N FROM RadTemplates');
  if (Number(n?.N || 0) > 0) return 0;
  let i = 0;
  for (const t of DEFAULT_RAD_TEMPLATES) {
    await db.insert('RadTemplates', { Name: t.name, Modality: t.modality, Title: t.title, Body: t.body, SortOrder: i++, Active: 1, CreatedAt: new Date() });
  }
  return i;
}
