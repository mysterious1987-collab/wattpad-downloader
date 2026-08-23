@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Push v2.5 len GitHub

set "ORIGIN=https://github.com/mysterious1987-collab/wattpad-downloader.git"

REM Resolve SRC (Object Github\v2.5) va ROOT (repo GitHub = workspace).
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

if exist "%HERE%\Object Github\v2.5\wattpad.js" (
  set "ROOT=%HERE%"
  set "SRC=%HERE%\Object Github\v2.5"
) else if exist "%HERE%\wattpad.js" (
  set "SRC=%HERE%"
  for %%I in ("%HERE%\..\..") do set "ROOT=%%~fI"
) else (
  echo [LOI] Khong tim thay wattpad.js ^(chay BAT o root workspace hoac trong Object Github\v2.5^).
  goto :end_fail
)

echo.
echo ========================================
echo   Push v2.5 len GitHub
echo ========================================
echo SRC    : !SRC!
echo ROOT   : !ROOT!
echo ORIGIN : !ORIGIN!
echo.
echo Neu ROOT chua clone: git init + fetch origin/main ^(giu lich su v2.4^),
echo roi copy loi v2.5, commit, push -u origin main ^(khong --force^).
echo KHONG add Object Github/, node_modules/, output/, state.
echo.
echo Nhan Ctrl+C de huy, hoac cho 3 giay...
timeout /t 3
echo.

set "GIT="
where git >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%G in ('where git') do (
    if not defined GIT set "GIT=%%G"
  )
)
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "GIT=%LocalAppData%\Programs\Git\cmd\git.exe"
if not defined GIT (
  echo [LOI] Chua cai Git. Tai: https://git-scm.com/download/win
  echo       Cai xong tick "Add Git to PATH", roi chay lai BAT.
  goto :end_fail
)
for %%D in ("!GIT!") do set "PATH=%%~dpD;!PATH!"
echo Dung git: !GIT!
echo.

echo --- Gan git / origin ---
git -C "!ROOT!" rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
  echo ROOT chua co .git — git init -b main
  git -C "!ROOT!" init -b main
  if errorlevel 1 goto :git_fail
)

git -C "!ROOT!" config --get user.name >nul 2>&1
if errorlevel 1 git -C "!ROOT!" config user.name "mysterious1987-collab"
git -C "!ROOT!" config --get user.email >nul 2>&1
if errorlevel 1 git -C "!ROOT!" config user.email "mysterious1987-collab@users.noreply.github.com"

git -C "!ROOT!" remote get-url origin >nul 2>&1
if errorlevel 1 (
  git -C "!ROOT!" remote add origin "!ORIGIN!"
  if errorlevel 1 goto :git_fail
) else (
  git -C "!ROOT!" remote set-url origin "!ORIGIN!"
)

echo --- git fetch origin ---
git -C "!ROOT!" fetch origin
if errorlevel 1 (
  echo [LOI] git fetch that bai. Dang nhap GitHub ^(Credential Manager / PAT^) roi chay lai BAT.
  goto :end_fail
)

git -C "!ROOT!" rev-parse --verify origin/main >nul 2>&1
if not errorlevel 1 (
  echo --- reset --hard origin/main ^(lich su v2.4, giu Object Github/^) ---
  git -C "!ROOT!" reset --hard origin/main
  if errorlevel 1 goto :git_fail
  git -C "!ROOT!" branch -M main
) else (
  echo [LOI] Khong thay origin/main sau fetch.
  goto :end_fail
)

echo --- Copy file loi v2.5 ---
copy /Y "!SRC!\wattpad.js"               "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\bns.js"                   "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\index.html"               "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\package.json"             "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\package-lock.json"        "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\.gitignore"               "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\urls.txt"                 "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\README.md"                "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\bns-browser-bridge.mjs"   "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\bns-playwright-cookie.mjs" "!ROOT!\" >nul || goto :copy_fail
copy /Y "!SRC!\REPO-CORE-V2.5.txt"       "!ROOT!\" >nul || goto :copy_fail

if not exist "!ROOT!\.github\workflows" mkdir "!ROOT!\.github\workflows"
copy /Y "!SRC!\.github\workflows\download.yml"     "!ROOT!\.github\workflows\" >nul || goto :copy_fail
copy /Y "!SRC!\.github\workflows\bns-download.yml" "!ROOT!\.github\workflows\" >nul || goto :copy_fail

robocopy "!SRC!\docs" "!ROOT!\docs" /E /NFL /NDL /NJH /NJS /nc /ns /np >nul
if errorlevel 8 goto :copy_fail

echo Copy xong.
echo --- git add ---
git -C "!ROOT!" add -- wattpad.js bns.js index.html package.json package-lock.json .gitignore urls.txt README.md
if errorlevel 1 goto :git_fail
git -C "!ROOT!" add -- bns-browser-bridge.mjs bns-playwright-cookie.mjs REPO-CORE-V2.5.txt
if errorlevel 1 goto :git_fail
git -C "!ROOT!" add -- .github/workflows/download.yml .github/workflows/bns-download.yml
if errorlevel 1 goto :git_fail
git -C "!ROOT!" add -- docs
if errorlevel 1 goto :git_fail
if exist "!ROOT!\push-v2.5-github.bat" git -C "!ROOT!" add -- push-v2.5-github.bat

echo --- git commit ---
git -C "!ROOT!" diff --cached --quiet
if errorlevel 1 (
  git -C "!ROOT!" commit -m "v2.5: TXT/MD/JSON giu xuong dong (br thanh doan van)"
  if errorlevel 1 goto :git_fail
) else (
  echo Khong co thay doi de commit.
)

echo --- git push -u origin main ---
git -C "!ROOT!" push -u origin main
if errorlevel 1 (
  echo [LOI] git push that bai. Kiem tra dang nhap GitHub ^(Credential Manager / PAT^). Khong dung --force.
  goto :end_fail
)

echo.
echo Xong. Tab Actions tren GitHub nen hien "Wattpad Downloader v2.5".
goto :end_ok

:copy_fail
echo [LOI] Copy file that bai.
goto :end_fail

:git_fail
echo [LOI] lenh git that bai.
goto :end_fail

:end_fail
echo.
pause
exit /b 1

:end_ok
echo.
pause
exit /b 0
