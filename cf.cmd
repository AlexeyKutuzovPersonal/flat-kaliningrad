@echo off
rem ============================================================
rem cf.cmd — wrangler на этой машине.
rem
rem Node здесь портативный и в PATH его нет, поэтому «npx wrangler»
rem не работает. Этот файл зовёт установленный локально wrangler
rem напрямую и передаёт ему все аргументы.
rem
rem   cf login
rem   cf d1 create dom-kgd-marks
rem   cf pages deploy
rem ============================================================
setlocal
set NODE=D:\Claude Cowork\CODE\LOCAL TOOLS\node24\node.exe
if not exist "%NODE%" (
  echo Не нашёл node по пути "%NODE%" — поправьте путь в cf.cmd
  exit /b 2
)
"%NODE%" "%~dp0node_modules\wrangler\bin\wrangler.js" %*
