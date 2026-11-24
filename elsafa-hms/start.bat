@echo off
chcp 65001 >nul
cd /d "%~dp0"
title نظام مستشفى الصفا
if not exist node_modules (
  echo تسطيب المكتبات لأول مرة...
  call npm install --omit=dev
)
node src/server.js
pause
