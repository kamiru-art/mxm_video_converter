@echo off
REM Lanzador para Windows: haz doble clic en este archivo para abrir Video to Contact Sheets.
REM La primera vez crea un entorno virtual e instala las dependencias solo.
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PYTHON="
where py >nul 2>nul && set "PYTHON=py -3"
if not defined PYTHON (
  where python >nul 2>nul && set "PYTHON=python"
)
if not defined PYTHON (
  echo.
  echo No se encontro Python 3.
  echo Instalalo desde https://www.python.org/downloads/ y marca la
  echo casilla "Add Python to PATH" durante la instalacion. Luego vuelve
  echo a hacer doble clic en este archivo.
  echo.
  pause
  exit /b 1
)

if not exist ".venv" (
  echo Creando entorno ^(solo la primera vez^)...
  %PYTHON% -m venv .venv
)

call ".venv\Scripts\activate.bat"

if not exist ".venv\.deps_ok" (
  echo Instalando dependencias ^(solo la primera vez, puede tardar un poco^)...
  python -m pip install --upgrade pip
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo Hubo un error instalando las dependencias.
    pause
    exit /b 1
  )
  echo ok> ".venv\.deps_ok"
)

echo Abriendo Video to Contact Sheets...
REM pythonw.exe abre la app SIN ventana de consola; al salir, esta se cierra.
if exist ".venv\Scripts\pythonw.exe" (
  start "" ".venv\Scripts\pythonw.exe" -m kamiru
) else (
  python -m kamiru
  if errorlevel 1 pause
)
