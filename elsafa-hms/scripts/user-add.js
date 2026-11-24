// إضافة مستخدم أو تغيير كلمة السر
// الاستخدام:  npm run user:add -- اسم_المستخدم "الاسم بالكامل" الدور كلمة_السر
// الأدوار: reception (استقبال) | cashier (خزينة) | lab (المعمل) | radiology (قسم الأشعة) | supervisor (مشرف) | reviewer (مراجع تعاقدات) | manager (مدير)
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { hashPassword, ROLES, loadRoles } from '../src/lib/auth.js';

const db = await createDb(loadConfig().db);
await loadRoles(db).catch(() => {});
const [username, fullName, role, password] = process.argv.slice(2);
if (!username || !fullName || !ROLES[role] || !password || password.length < 6) {
  console.log('الاستخدام: npm run user:add -- username "الاسم بالكامل" role password');
  console.log('الأدوار: ' + Object.entries(ROLES).map(([k, v]) => `${k} (${v})`).join(' | '));
  console.log('كلمة السر 6 حروف على الأقل');
  process.exit(1);
}
const u = username.toLowerCase();
const hash = await hashPassword(password);
const ex = await db.one('SELECT Id FROM Users WHERE Username = ?', [u]);
if (ex) {
  await db.run('UPDATE Users SET FullName = ?, Role = ?, PasswordHash = ?, Active = 1 WHERE Id = ?', [fullName, role, hash, ex.Id]);
  console.log(`اتحدّث المستخدم ${u}`);
} else {
  await db.insert('Users', { Username: u, FullName: fullName, Role: role, PasswordHash: hash, Active: 1, CreatedAt: new Date() });
  console.log(`اتضاف المستخدم ${u} (${ROLES[role]})`);
}
await db.close();
