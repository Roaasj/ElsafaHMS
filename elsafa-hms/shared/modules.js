// الأقسام اللي المدير يقدر يقفلها أو يفتحها من الإعدادات (نسخة الصفا كاث مثلًا مش بتستخدم المعمل والأشعة والصيدلية والتعاقدات)
// القسم الموقوف: صلاحياته مبتشتغلش لأي حد (حتى المدير)، وشاشاته بتختفي، والـ API بتاعه بيرفض.
export const MODULES = {
  lab: { key: 'modLab', name: 'المعمل والأشعة', perms: ['lab.', 'rad.'], api: ['/lab', '/radiology'] },
  pharmacy: { key: 'modPharmacy', name: 'الصيدلية', perms: ['pharmacy.', 'reports.pharmacy'], api: [] },
  contracts: { key: 'modContracts', name: 'التعاقدات والمطالبات', perms: ['payers.', 'approvals.', 'claims.'], api: ['/payers', '/approvals', '/claims'] },
  inpatient: { key: 'modInpatient', name: 'الإقامة والأسرّة', perms: ['admissions.', 'adm.', 'beds.'], api: ['/admissions'] },
};
export const moduleOfPerm = (perm) => Object.entries(MODULES).find(([, m]) => m.perms.some((p) => perm === p || perm.startsWith(p.endsWith('.') ? p : p + '.')))?.[0] || null;
export const moduleOfApi = (path) => Object.entries(MODULES).find(([, m]) => m.api.some((p) => path === p || path.startsWith(p + '/')))?.[0] || null;
