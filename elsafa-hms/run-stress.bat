@echo off
chcp 65001 >nul
cd /d "%~dp0"
set LOG=%~dp0stress-log.txt
echo ===== بدء %date% %time% ===== > "%LOG%"
call npm install --no-audit --no-fund >> "%LOG%" 2>&1
rem === قاعدة تجربة منفصلة تماما، قاعدة التشغيل ما بتتلمسش ===
set MSSQL_DATABASE=ElsafaHMS_Stress
set PORT=3100
set COOKIE_NAME=stress_sid
set STRESS_MSSQL=1
echo [1/3] مسح قاعدة التجربة القديمة (لو موجودة)...
node scripts\stress-reset.mjs >> "%LOG%" 2>&1
if errorlevel 1 ( echo فشل المسح، شوف stress-log.txt & goto end )
echo [2/3] إنشاء القاعدة وتشغيل التحديثات...
echo ----- db:init ----- >> "%LOG%"
call npm run db:init >> "%LOG%" 2>&1
if errorlevel 1 ( echo فشل db:init، شوف stress-log.txt & goto end )
echo [3/3] سيناريو الضغط...
echo ----- scenario ----- >> "%LOG%"
node scripts\scenario.mjs >> "%LOG%" 2>&1
echo ----- exit code %errorlevel% ----- >> "%LOG%"
:end
echo ===== نهاية %date% %time% ===== >> "%LOG%"
echo.
echo خلص. النتيجة في stress-log.txt جنب الملف ده. اقفل النافذة.
pause
