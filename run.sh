#!/usr/bin/env bash
# Lanzador para Linux (y macOS desde terminal).
# La primera vez crea un entorno e instala las dependencias automáticamente.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Elige un Python 3 que tenga Tkinter (la librería de la ventana) y, a ser
# posible, una versión de Tk moderna (>= 8.6).
pick_python() {
  local cands=() p w
  for p in /Library/Frameworks/Python.framework/Versions/*/bin/python3; do
    [ -x "$p" ] && cands+=("$p")
  done
  for name in python3.13 python3.12 python3.11 python3.10 python3; do
    w="$(command -v "$name" 2>/dev/null || true)"
    [ -n "$w" ] && cands+=("$w")
  done
  for p in "${cands[@]}"; do
    if "$p" -c 'import tkinter,sys; sys.exit(0 if tkinter.TkVersion>=8.6 else 1)' >/dev/null 2>&1; then
      echo "$p"; return 0
    fi
  done
  for p in "${cands[@]}"; do
    if "$p" -c 'import tkinter' >/dev/null 2>&1; then
      echo "$p"; return 0
    fi
  done
  return 1
}

# Camino rápido: si uv está instalado, él se encarga del entorno y de instalar
# EXACTAMENTE las versiones de uv.lock (mismo software que el ejecutable
# oficial). Es mucho más rápido que pip y reproducible.
if command -v uv >/dev/null 2>&1; then
  echo "Usando uv (entorno reproducible desde uv.lock)…"
  exec uv run --frozen --extra desktop python -m kamiru
fi
echo "uv no está instalado; se usará pip (más lento)."
echo "  Consejo: instálalo con  curl -LsSf https://astral.sh/uv/install.sh | sh"

if ! command -v python3 >/dev/null 2>&1; then
  echo "No se encontró python3. Instálalo con el gestor de paquetes de tu sistema."
  echo "  Debian/Ubuntu:  sudo apt install python3 python3-venv python3-tk"
  echo "  Fedora:         sudo dnf install python3 python3-tkinter"
  exit 1
fi

PYBIN="$(pick_python || true)"
if [ -z "$PYBIN" ]; then
  echo "Se encontró python3, pero le falta Tkinter (la librería de la ventana)."
  echo "Instálala con:"
  echo "  Debian/Ubuntu:  sudo apt install python3-tk"
  echo "  Fedora:         sudo dnf install python3-tkinter"
  exit 1
fi
echo "Usando Python: $PYBIN"

# Si el entorno existente tiene un Tk viejo, se recrea con el Python elegido.
if [ -d ".venv" ]; then
  if ! .venv/bin/python -c 'import tkinter,sys; sys.exit(0 if tkinter.TkVersion>=8.6 else 1)' >/dev/null 2>&1; then
    echo "El entorno anterior usaba un Tk antiguo o sin Tkinter; recreándolo…"
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
