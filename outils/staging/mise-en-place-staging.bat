@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Chip Defender Arena - mise en place du staging
echo.
where node >nul 2>nul || ( echo  Node.js manquant : lance d'abord installer-serveur.bat & pause & exit /b 1 )
if not exist "depot-staging\.git" ( echo  Lance d'abord installer-staging.bat ^(il télécharge le dépôt privé^) & pause & exit /b 1 )
git -C depot-staging pull -q --rebase --autostash
rem outil GitHub en ligne de commande (gh) : installé s'il manque
set "GH_EXE="
where gh >nul 2>nul && set "GH_EXE=gh"
if not defined GH_EXE if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "GH_EXE=%ProgramFiles%\GitHub CLI\gh.exe"
if not defined GH_EXE (
  echo  Installation de l'outil GitHub ^(gh^) avec winget...
  winget install -e --id GitHub.cli --accept-source-agreements --accept-package-agreements
  if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "GH_EXE=%ProgramFiles%\GitHub CLI\gh.exe"
)
if not defined GH_EXE ( echo  gh introuvable après installation : ferme cette fenêtre et relance. & pause & exit /b 1 )
node "depot-staging\outils\staging\mise-en-place.mjs"
echo.
pause
