@echo off
chcp 65001 >nul
title Chip Defender Arena - migration DNS vers Cloudflare
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js est necessaire : https://nodejs.org & pause & exit /b 1)
if not exist "depot-site\outils\dns\migrer-dns.mjs" (echo Depot introuvable : lance d'abord installer-serveur.bat & pause & exit /b 1)
cd depot-site && git pull -q 2>nul & cd ..
node "depot-site\outils\dns\migrer-dns.mjs"
pause
