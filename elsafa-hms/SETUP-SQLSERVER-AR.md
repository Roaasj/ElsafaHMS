# أول تشغيل على SQL Server (تجربة)

> اشتغل على قاعدة **تجربة** اسمها `ElsafaHMS_Test` مش قاعدة التشغيل.

## 0) المتطلبات على الجهاز
- **Node.js 22.23.4 أو أحدث** (https://nodejs.org → LTS). تأكد: افتح CMD واكتب `node -v`.
- **SQL Server** شغّال، مع **TCP/IP مفعّل** (SQL Server Configuration Manager ← SQL Server Network Configuration ← Protocols ← TCP/IP = Enabled، وبعدين أعد تشغيل خدمة SQL Server).
- وضع الدخول **Mixed Mode** (SQL Server and Windows Authentication): SSMS ← كليك يمين على السيرفر ← Properties ← Security. (محتاج Restart للخدمة.)
- لو متسطب Express فغالبًا بيكون Named Instance اسمه `SQLEXPRESS`.

## 1) إنشاء مستخدم للبرنامج (في SSMS، New Query)
```sql
CREATE LOGIN elsafa_hms WITH PASSWORD = 'ضع_كلمة_سر_قوية_إنجليزي', CHECK_POLICY = OFF;
ALTER SERVER ROLE dbcreator ADD MEMBER elsafa_hms;
```
(`dbcreator` تكفي: البرنامج هينشئ القاعدة وهيبقى مالكها.)

## 2) فك الـzip في فولدر، مثلًا `C:\elsafa-hms`، وبعدين من CMD داخله:
```
npm install
copy .env.example .env
notepad .env
```
عدّل في `.env`:
```
DB_DRIVER=mssql
MSSQL_SERVER=localhost
MSSQL_INSTANCE=SQLEXPRESS     (لو Express؛ سيبه فاضي لو Default Instance وخلي MSSQL_PORT=1433)
MSSQL_PORT=                   (فاضي لو بتستخدم MSSQL_INSTANCE)
MSSQL_DATABASE=ElsafaHMS_Test
MSSQL_USER=elsafa_hms
MSSQL_PASSWORD=كلمة_السر_اللي_اخترتها
MSSQL_ENCRYPT=false
MSSQL_TRUST_CERT=true
```

## 3) إنشاء القاعدة والجداول (13 تحديث)
```
npm run db:init
```
المتوقع: `اتعملت قاعدة ElsafaHMS_Test` ثم `تمام: القاعدة على النسخة 13.`
أي رسالة خطأ: صوّرها وابعتها كما هي.

## 4) فحص دقة الأرقام (ده المطلوب مني قبل الخطوة 2)
```
node scripts/mssql-precision-check.mjs --db ElsafaHMS_Test --schema
```
بيعمل جدول مؤقت داخل قاعدة التجربة ويمسحه. هيطبع ✓/✗ ويكتب `precision-check.result.json`. **ابعتلي الملف ده + اللي ظهر على الشاشة.**

## 5) تشغيل البرنامج بالبيانات التجريبية
```
npm run seed:demo
npm start
```
افتح `http://localhost:3000` — المستخدمين: manager / super / reception / cashier / storeacc / pharm / fin / claims / acc / review، وكلمة السر `Safa@2026`.

## لو حصلت مشكلة
| الرسالة | الحل |
|---|---|
| `ECONNREFUSED` / `Failed to connect` | TCP/IP مش مفعّل أو الخدمة واقفة، أو الـInstance غلط، وخدمة **SQL Server Browser** لازم تكون شغالة مع الـNamed Instance |
| `Login failed for user` | كلمة السر أو Mixed Mode مش مفعّل |
| `CREATE DATABASE permission denied` | الـlogin ناقصه `dbcreator` |
| خطأ شهادة/SSL | خلي `MSSQL_TRUST_CERT=true` و`MSSQL_ENCRYPT=false` |
