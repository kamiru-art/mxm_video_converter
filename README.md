# Kamiru Studio 💚☀️

Una sola app de escritorio (con ventana, **sin tocar código, sin Photoshop**)
para todo el flujo de animación *mixed media* y *cianotipia* de Kamila:

```
🎬 video (o carpeta de imágenes)
   → 🖨️ hojas de contacto imprimibles (con marcadores de registro)
      → ✋ pintar sobre el papel  /  ☀️ exponer cianotipias desde acetatos
         → 📠 escanear todo (en cualquier orden y orientación)
            → 🤖 la app endereza, identifica y recorta cada fotograma sola
               → 🎬 video final reconstruido
```

Funciona en **Windows, macOS y Linux**. Extrae los fotogramas **sin pérdida de
calidad** (PNG) y **sin alterar el color**.

> 📖 **¿Primera vez?** Lee el **[MANUAL.md](MANUAL.md)** — la guía completa
> paso a paso, escrita para usarse sin conocimientos técnicos.

Esta versión 2 une en una sola app a *Video to Contact Sheets* y a
*Kamiru MXM Scans Helper* (el repo `kamiru_mxm_scans_helper` queda jubilado).

---

## ✨ Qué puede hacer

### Fase ① — Generar hojas
- Origen: **un video** o **una carpeta de imágenes** (frames exportados, dibujos…).
- **Todo el video** o solo un **rango** (inicio y fin en segundos).
- **Fotogramas por segundo (fps)** con decimales (p. ej. `0.5`), o **TODOS los
  fotogramas** (mixed media).
- **Cuadrícula libre** (columnas × filas), espaciado en mm, márgenes, DPI,
  tamaño de hoja (A4, A3, A5, A6, B4, B5, Carta, Oficio, Tabloide o
  personalizado) y orientación **vertical/horizontal/mejor ajuste automático**
  (el mejor ajuste también prueba la cuadrícula intercambiada — 4×5 ↔ 5×4 —
  y elige la combinación que hace los fotogramas MÁS GRANDES, igual o mejor
  que eligiendo a mano).
- **Incluir/excluir fotogramas** por posición (`1, 3-5`) y **elegir qué hojas
  producir** (`3, 5-7`) — perfecto para reimprimir una hoja dañada.
- 🆕 **Detección de dibujos repetidos** (deduplicación perceptual): los frames
  sostenidos/repetidos se imprimen **una sola vez** y se reutilizan al armar el
  video. Ahorra papel, tinta y horas de pintura.
- **Nombres autoincrementales** (`abc_001…`) o el **nombre del archivo
  original**; fuente, tamaño, color y numeración continua u original.
- **Numerador de hoja** en cualquier esquina, con prefijo y ceros.
- 🆕 **Marcadores de registro ArUco REDUNDANTES** (4, 8 o 12): la hoja
  escaneada se alinea sola aunque varios marcadores queden pintados, tapados o
  cortados (con 8, bastan 3 sanos). Más **un código QR por fotograma** que
  identifica cada hoja aunque se escaneen desordenadas.
- 🆕 **Modo CIANOTIPIA**: genera **negativos para acetato** — invertidos,
  espejados (opcional), con **color o degradado de tinta configurable** y
  **curva de compensación calibrable** (método *Easy Digital Negatives*,
  integrado). Los marcadores/QRs/nombres se invierten para que en la copia
  azul queden con la polaridad correcta.
- 🆕 **Ahorro de tinta en cianotipia**: elige entre fondo **completamente
  entintado** (fondo blanco en la copia) o modo **AHORRO** (fondo
  transparente: solo los marcadores, QRs y nombres llevan un **halo
  entintado** para distinguirse del fondo azul — gasta una fracción de la
  tinta).
- 🆕 **Tira de parches de grises** opcional para normalizar el escáner.
- 🆕 **Presets con nombre** (guarda/carga configuraciones completas).
- **Vista previa navegable de todas las hojas** (incluye marcadores, negativos
  de cianotipia e incluso una **simulación de la copia azul final**).
- Salida en **PNG**, **PDF combinado** y/o **TIFF** + copia de fotogramas
  originales + `layout.json` (el mapa para la fase ②).

### Fase ② — Procesar escaneos  🆕 (adiós Photoshop)
- Lee los escaneos (TIFF/PNG/JPG, **8 o 16 bits**, a **cualquier resolución** —
  la escala real se mide sola con los marcadores).
- Endereza cada hoja con **homografía RANSAC** usando **todos** los marcadores
  detectados; funciona con hojas **rotadas o de cabeza**.
- Identifica la hoja con **cualquier QR legible** (¡uno basta!) y recorta cada
  fotograma según el `layout.json`, con **bleed** ajustable.
- **Modo cianotipia**: preprocesado especial (canal rojo + CLAHE) tolerante a
  la variabilidad de tonos del azul de Prusia.
- **Procesamiento en paralelo** (configurable, pensado para máquinas potentes).
- **Modo emergencia**: si ningún QR es legible, los recortes se guardan en
  `sin_identificar/` para no perder el arte.
- 🆕 **Informe** HTML con miniaturas + JSON + CSV: qué se recuperó, qué falta.
- 🆕 **Hojas de rescate**: un botón reimprime SOLO los fotogramas fallidos.
- Compatible con los `layout.json` de la app antigua (v1).

### Fase ③ — Calibración  🆕
- **Perfil de impresora**: imprime una página de prueba, escanéala y la app
  mide la **escala real** de tu impresora (y la compensa al generar hojas),
  su **respuesta tonal** y el **tamaño mínimo fiable** de marcador y de QR.
- **Perfil de cianotipia (curva)** con carta a elegir:
  - **Tira Kamiru** (21 parches, rápida), o
  - **Carta EDN 2.2** (los **256 tonos** del método
    [Easy Digital Negatives](http://www.easydigitalnegatives.com/) de Peter
    Mrhar → curva muy fina), ambas con el marco de marcadores de Kamiru para
    que el análisis del escaneo sea **automático** (sin recortar a mano).
- **EDN ColorBlocker 3**: la carta de **36 matices × 21 variantes + grises**
  que descubre **qué color de tinta bloquea mejor el UV en TU impresora**
  (el negro no siempre es lo mejor). El perfil resultante trae el mejor color
  y un **degradado de 3 paradas** que se aplica a los negativos con un clic.
- Si activas el modo cianotipia sin perfil, la app te ofrece generar la hoja
  de calibración antes de imprimir nada.

### Fase ④ — Video final  🆕
- Reconstruye el video (MP4 H.264, H.264 4:4:4 o **ProRes**) con los
  fotogramas procesados **en su orden original**, reutilizando los
  deduplicados en todas sus posiciones. El fps se lee del proyecto.

---

## 🚀 Cómo abrirla

### Opción A (recomendada): ejecutable listo, sin instalar nada

Ve a la página de **[Releases](../../releases)** del repositorio y descarga el
archivo de tu sistema:

| Sistema | Archivo |
|---|---|
| Windows | `Kamiru-Studio-windows.zip` → descomprime y abre `Kamiru-Studio.exe` |
| macOS Apple Silicon (M1–M4) | `Kamiru-Studio-macos-apple-silicon.zip` → abre `Kamiru-Studio.app` |
| macOS Intel | `Kamiru-Studio-macos-intel.zip` |
| Linux | `Kamiru-Studio-linux.tar.gz` → ejecuta `Kamiru-Studio/Kamiru-Studio` |

**No hace falta Python ni `git clone`.** En macOS, la primera vez: clic
derecho → Abrir → Abrir (app sin firmar); en Windows, si SmartScreen avisa:
«Más información» → «Ejecutar de todas formas».

### Opción B: desde el código (doble clic, sin terminal)

Solo necesitas tener **Python 3** instalado. La primera vez prepara el entorno
e instala las dependencias sola (2–3 minutos); después abre al instante.

> ⚠️ **macOS — importante:** guarda esta carpeta **fuera de Documentos,
> Escritorio y Descargas** (por ejemplo en `~/Kamiru Studio`). macOS bloquea a
> las apps el acceso a esas tres carpetas protegidas.

### macOS — `Video to Contact Sheets.app`
1. Instala Python desde <https://www.python.org/downloads/>.
2. Doble clic en la app. Primera vez: clic derecho → **Abrir** → **Abrir**.

### Windows — `Abrir Video to Contact Sheets.vbs`
1. Instala Python desde <https://www.python.org/downloads/> y **marca
   "Add Python to PATH"**.
2. Doble clic en el `.vbs` (sin consola negra). También existe `run.bat`.

### Linux — `Instalar en Linux.sh`
1. `sudo apt install python3 python3-venv python3-tk` (Debian/Ubuntu) o
   `sudo dnf install python3 python3-tkinter` (Fedora).
2. Ejecuta una vez `./Instalar en Linux.sh`; la app queda en tu menú.
   También puedes usar `./run.sh`.

---

## 🎨 Sobre la calidad y el color

- Los fotogramas se extraen a **PNG sin pérdida**; no se recomprime nada.
- **No se aplica ningún filtro de color** en modo normal. La única conversión
  es YUV→RGB del decodificador, como en cualquier reproductor.
- Las hojas se componen a alta resolución (DPI configurable) con remuestreo
  **LANCZOS**; la alineación de escaneos usa interpolación **LANCZOS4** y los
  escaneos de **16 bits se conservan de punta a punta**.
- En modo cianotipia sí se aplica (a propósito) la inversión y la curva de
  compensación calibrada: para eso está.

---

## 🔧 Para quien sí quiera la terminal (opcional)

> En macOS el comando suele ser `python3` (no `python`). En Windows, `py`.

```bash
python3 -m pip install -r requirements.txt
python3 -m kamiru          # abre la app
python3 tests/test_pipeline.py   # prueba de integración (sin GUI)
```

No hace falta instalar `ffmpeg` aparte: viene incluido vía `imageio-ffmpeg`.
`pyzbar` es opcional (refuerzo para QRs muy dañados; requiere libzbar).

### ¿La ventana se abre en blanco (macOS)?

Es el **Tk 8.5** obsoleto de macOS. Usa el Python de
[python.org](https://www.python.org/downloads/) (trae Tk 8.6). Si lo arreglas a
mano: `rm -rf .venv` y vuelve a abrir.

---

## 📦 Qué hay dentro

```
kamiru/                    El código de la app (paquete Python)
  app.py          Ventana principal + fase ① (generar hojas)
  gui_phases.py   Fases ② escaneos, ③ calibración y ④ video
  gui_common.py   Estilos y utilidades compartidas de la interfaz
  core.py         Composición de hojas (grillas, marcadores, cianotipia)
  markers.py      Marcadores ArUco redundantes y códigos QR
  scan.py         Procesador de escaneos (alineación, recorte, informe)
  calibration.py  Página de prueba de impresora y tira de cianotipia
  cyanotype.py    Negativos: inversión, curva, color de tinta, espejado
  dedup.py        Detección de dibujos repetidos (hash perceptual)
  rescue.py       Hojas de rescate (reimprimir solo lo fallido)
  layoutfile.py   Lectura/escritura del layout.json (v2 + compat. v1)
  videoout.py     Reconstrucción del video final (ffmpeg)
  ffmpeg_utils.py Extracción de fotogramas y sondeo del video
  paper.py        Tamaños de hoja y conversiones mm/px
  fonts.py        Búsqueda de fuentes del sistema
  config.py       Ajustes, presets y perfiles de calibración
tests/test_pipeline.py     Prueba de integración de todo el pipeline
MANUAL.md                  La guía completa de uso, paso a paso
```

Hecho con cariño. 💚
