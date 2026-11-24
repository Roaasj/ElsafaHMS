-- افحص حالة القاعدة بعد فشل 006 (قراءة فقط، مفيش تعديل). شغّله على ElsafaHMS_Test
SELECT MAX(Version) AS آخر_نسخة_مطبقة FROM SchemaVersion;           -- المتوقع 5
SELECT name FROM sys.tables WHERE name LIKE 'Lab%' ORDER BY name;      -- المتوقع: ولا صف (006 اتلغى بالكامل)
SELECT COUNT(*) AS مستخدمين FROM Users;                                -- بياناتك زي ما هي
