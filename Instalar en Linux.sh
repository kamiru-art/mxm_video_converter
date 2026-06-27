#!/usr/bin/env bash
# Instala "Video to Contact Sheets" como una app clicable en Linux:
# crea una entrada en el menú de aplicaciones (y un ícono en el Escritorio)
# que abre la app SIN terminal. Ejecuta este archivo una sola vez.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$DIR/run.sh" 2>/dev/null || true

APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
DESKTOP="$APPS/video-to-contact-sheets.desktop"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Video to Contact Sheets
Comment=Convierte un video en contact sheets imprimibles
Exec="$DIR/run.sh"
Icon=$DIR/assets/icon.png
Terminal=false
Categories=Graphics;AudioVideo;Utility;
EOF
chmod +x "$DESKTOP"

# Copia también un acceso al Escritorio si existe (en español o inglés).
for D in "$HOME/Desktop" "$HOME/Escritorio"; do
  if [ -d "$D" ]; then
    cp "$DESKTOP" "$D/Video to Contact Sheets.desktop"
    chmod +x "$D/Video to Contact Sheets.desktop" 2>/dev/null || true
    # Marca el lanzador como "de confianza" (GNOME) para poder hacer doble clic.
    gio set "$D/Video to Contact Sheets.desktop" metadata::trusted true 2>/dev/null || true
  fi
done

update-desktop-database "$APPS" 2>/dev/null || true

echo "¡Listo! Busca «Video to Contact Sheets» en tu menú de aplicaciones"
echo "(o usa el ícono del Escritorio). Se abre sin terminal."
