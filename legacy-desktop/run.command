#!/usr/bin/env bash
# Lanzador para macOS — doble clic en Finder para abrir la app.
# La primera vez crea un entorno e instala las dependencias automáticamente.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Elige un Python 3 con una versión de Tk MODERNA (>= 8.6). Importante en macOS:
# el Tk 8.5 que trae el sistema de fábrica está obsoleto y a menudo dibuja la
# ventana EN BLANCO. El Python de python.org incluye un Tk 8.6 que sí funciona,
# así que lo preferimos.
# Camino rápido: si uv está instalado, él prepara el entorno con EXACTAMENTE
# las versiones de uv.lock (el mismo software que el ejecutable oficial).
if command -v uv >/dev/null 2>&1; then
  echo "Usando uv (entorno reproducible desde uv.lock)…"
  exec uv run --frozen --extra desktop python -m kamiru
fi

pick_python() {
  local cands=() p w
  for p in /Library/Frameworks/Python.framework/Versions/*/bin/python3; do
    [ -x "$p" ] && cands+=("$p")
  done
  for name in python3.13 python3.12 python3.11 python3.10 python3; do
    w="$(command -v "$name" 2>/dev/null || true)"
    [ -n "$w" ] && cands+=("$w")
  done
  # 1ª pasada: el primero con Tk >= 8.6.
  for p in "${cands[@]}"; do
    if "$p" -c 'import tkinter,sys; sys.exit(0 if tkinter.TkVersion>=8.6 else 1)' >/dev/null 2>&1; then
      echo "$p"; return 0
    fi
  done
  # 2ª pasada: al menos uno que tenga tkinter (aunque sea viejo).
  for p in "${cands[@]}"; do
    if "$p" -c 'import tkinter' >/dev/null 2>&1; then
      echo "$p"; return 0
    fi
  done
  return 1
}

PYBIN="$(pick_python || true)"
if [ -z "$PYBIN" ]; then
  osascript -e 'display alert "Falta Python" message "Instala Python 3 desde https://www.python.org/downloads/ (incluye lo necesario para la ventana) y vuelve a hacer doble clic en este archivo."' >/dev/null 2>&1 || true
  echo "No se encontró un Python 3 con Tk. Instálalo desde https://www.python.org/downloads/"
  read -n 1 -s -r -p "Pulsa una tecla para cerrar…"
  exit 1
fi
echo "Usando Python: $PYBIN"

# Si ya existe un entorno pero su Tk es viejo (p. ej. se creó con el Python del
# sistema y la ventana salía en blanco), se recrea con el Python bueno.
if [ -d ".venv" ]; then
  if ! .venv/bin/python -c 'import tkinter,sys; sys.exit(0 if tkinter.TkVersion>=8.6 else 1)' >/dev/null 2>&1; then
    echo "El entorno anterior usaba un Tk antiguo; recreándolo…"
    rm -rf .venv
  fi
fi

if [ ! -d ".venv" ]; then
  echo "Creando entorno (solo la primera vez)…"
  "$PYBIN" -m venv .venv
  rm -f .venv/.deps_ok
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [ ! -f ".venv/.deps_ok" ]; then
  echo "Instalando dependencias (solo la primera vez)…"
  python -m pip install --upgrade pip
  python -m pip install -r requirements.txt
  touch .venv/.deps_ok
fi

echo "Abriendo Video to Contact Sheets…"
python -m kamiru
