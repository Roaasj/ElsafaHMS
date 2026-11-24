// العيادات: النقل التلقائي من تخصصات الأطباء (مرة واحدة)، ومخزن لكل عيادة
export async function seedClinics(db) {
  if (await db.one("SELECT Value FROM AppSettings WHERE [Key] = 'clinicsSeed'")) return 0;
  const now = new Date();
  const docs = await db.query('SELECT Id, Specialty FROM Doctors WHERE ClinicId IS NULL');
  const byName = new Map();
  for (const d of docs) {
    const n = String(d.Specialty || '').replace(/\s+/g, ' ').trim();
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(d.Id);
  }
  let i = 1;
  for (const [name, ids] of byName) {
    let c = await db.one('SELECT Id FROM Clinics WHERE Name = ?', [name]);
    if (!c) {
      const sid = await db.insert('Stores', { Name: `مخزن ${name}`, Kind: 'sub', Holds: 'all', Notes: 'مخزن عيادة', SortOrder: 100 + i, Active: 1, CreatedAt: now });
      c = { Id: await db.insert('Clinics', { Name: name, StoreId: sid, SortOrder: i, Active: 1, CreatedAt: now }) };
    }
    i++;
    for (const id of ids) await db.run('UPDATE Doctors SET ClinicId = ? WHERE Id = ?', [c.Id, id]);
  }
  if (docs.length) await db.insert('AppSettings', { '[Key]': 'clinicsSeed', Value: '1', UpdatedAt: now }); // من غير أطباء مفيش حاجة تتنقل
  return byName.size;
}

/** مخزن عيادة الزيارة: عيادة آخر دكتور اتكتب له كشف في الزيارة (لو العيادة ليها مخزن شغّال) */
export async function clinicStoreOfVisit(t, visitId) {
  return t.one(
    t.top(`SELECT s.* FROM VisitItems i JOIN Doctors d ON d.Id = i.DoctorId JOIN Clinics c ON c.Id = d.ClinicId JOIN Stores s ON s.Id = c.StoreId
            WHERE i.VisitId = ? AND i.DoctorId IS NOT NULL AND i.Status = 'active' AND c.Active = 1 AND s.Active = 1 ORDER BY i.Id DESC`, 1), [visitId]);
}
/** المخزن ده مخزن عيادة؟ (الاستقبال بيصرف منه في زيارات العيادات من غير ربط بالمستخدم) */
export async function isClinicStore(t, storeId) {
  return !!(await t.one('SELECT Id FROM Clinics WHERE StoreId = ?', [Number(storeId) || 0]));
}
