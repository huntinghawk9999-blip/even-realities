@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 가 없습니다. https://nodejs.org 에서 LTS 를 설치하세요. & pause & exit /b 1)
echo 네이버 키는 브라우저에서 http://localhost:8790 을 열어 넣으세요(폰 앱에서도 가능).
start "" http://localhost:8790
node --env-file-if-exists=.env server.mjs
pause
