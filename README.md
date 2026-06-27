# Video to Contact Sheets 💚

Una app de escritorio sencilla (con ventana, **sin tocar código**) para convertir
un video en **contact sheets** imprimibles: hojas con una cuadrícula de fotogramas
extraídos del video, cada uno con su nombre, listas para imprimir o archivar.

Hecha con cariño para **Kamila**. Funciona en **Windows, macOS y Linux**, extrae
los fotogramas **sin pérdida de calidad** (PNG) y **sin alterar el color**.

---

## ✨ Qué puede hacer

- **Todo el video** o solo un **rango** (inicio y fin en segundos).
- Elegir **cuántos fotogramas por segundo (fps)** extraer — admite decimales
  (p. ej. `0.5` = 1 fotograma cada 2 segundos), o **extraer TODOS los fotogramas**
  (ideal para *mixed media*).
- Elegir **cuántas imágenes por hoja** (columnas × filas).
- **Vista previa** 👁 de **todas las hojas** antes de generar, con botones para
  **navegar** entre ellas (◀ ▶ o las flechas del teclado). Respeta orientación,
  nombres, numerador y la selección de fotogramas.
- **Elegir qué fotogramas salen**: un campo para **incluir solo** ciertas
  posiciones y otro para **excluir**, con sintaxis de rangos (p. ej. `1, 3-5`).
- **Espaciado entre frames** dentro de la hoja, ajustable en milímetros.
- Tamaño de hoja **A4** por defecto, y también **A3, A5, A6, B4, B5, Carta,
  Oficio, Tabloide** o uno **personalizado** (ancho × alto en mm).
- **Orientación de la hoja**: **Vertical**, **Horizontal** o **Mejor ajuste
  (automático)** — esta última elige por ti la orientación que hace los
  fotogramas **más grandes** (maximiza el área de impresión). Los nombres y el
  numerador de hoja se acomodan solos a la orientación elegida.
- **Nombres autoincrementales** para cada frame: por ejemplo `abc_1, abc_2, …`
  o `abc_001, abc_002, …`. Puedes elegir:
  - el **nombre base** (`abc`),
  - el **separador** entre el nombre y el número (`_`, `-`, espacio, lo que sea),
  - la cantidad de **ceros a la izquierda** (para tener `1` o `001`),
  - desde qué **número empezar**.
  - la **numeración**: **continua** (1, 2, 3…) o **original** (la posición real
    del fotograma en el video, p. ej. `5, 10, 15` si incluyes esos), para no
    perder el orden real cuando incluyes o excluyes fotogramas.
  - Por defecto el **nombre base es el del video** (+ sufijos); puedes
    desactivarlo para escribir el tuyo.
- **Numerador de hoja** opcional en cualquier **esquina**, para organizarte
  fácil (con texto antes del número, p. ej. `Hoja 1`), y con **ceros a la
  izquierda** configurables (`Hoja 001`) para que las hojas se ordenen bien.
- Elegir la **fuente**, el **tamaño de fuente** y el **margen entre el frame y
  su nombre** para las etiquetas.
- Guarda en **PNG** (sin pérdida), **PDF** combinado (perfecto para imprimir) y/o
  **TIFF**. Opción extra: guardar **cada fotograma individual** a máxima calidad.
- Recuerda tus ajustes para la próxima vez.

---

## 🚀 Cómo abrirla (doble clic, sin terminal)

Solo necesitas tener **Python 3** instalado. Cada sistema tiene su forma de
abrirla como una app de verdad. La primera vez prepara el entorno e instala las
dependencias sola (1–2 minutos); después abre al instante.

> ⚠️ **macOS — importante:** guarda esta carpeta **fuera de Documentos, Escritorio
> y Descargas** (por ejemplo en tu carpeta de inicio, `~/Video to Contact Sheets`).
> macOS bloquea a las apps el acceso a esas tres carpetas protegidas, y verías un
> error «Operation not permitted». En cualquier otra ubicación funciona sin pedir
> permisos.

### macOS  — `Video to Contact Sheets.app`
1. Instala Python desde <https://www.python.org/downloads/> (incluye lo necesario
   para la ventana).
2. Haz **doble clic en `Video to Contact Sheets.app`**. Se abre como cualquier
   app, **sin que aparezca ninguna terminal**.

> Primera vez: clic derecho sobre la app → **Abrir** → **Abrir** (es una app sin
> firmar). Truco: arrástrala al **Dock** para tenerla a mano.
>
> Si ya la tenías en Documentos y daba error: muévela (con su carpeta) a `~/` y
> vuelve a abrirla. ¿Prefieres la terminal? También existe `run.command`.

### Windows  — `Abrir Video to Contact Sheets.vbs`
1. Instala Python desde <https://www.python.org/downloads/> y **marca la casilla
   "Add Python to PATH"**.
2. Haz **doble clic en `Abrir Video to Contact Sheets.vbs`**. Abre la app **sin
   consola negra**. (También existe `run.bat`.)

### Linux  — `Instalar en Linux.sh`
1. Instala Python y Tk:
   - Debian/Ubuntu: `sudo apt install python3 python3-venv python3-tk`
   - Fedora: `sudo dnf install python3 python3-tkinter`
2. Ejecuta **una vez** `./Instalar en Linux.sh` (o doble clic → «Ejecutar»). Eso
   añade **Video to Contact Sheets** a tu menú de aplicaciones y al Escritorio.
3. Ábrela desde el menú/Escritorio (se abre **sin terminal**). También puedes
   usar `./run.sh` directamente.

---

## 🧭 Cómo usarla, paso a paso

La ventana tiene pestañas numeradas:

1. **Video y rango** — elige el archivo de video y si quieres *todo el video* o un
   *inicio/fin en segundos*.
2. **Extracción y cuadrícula** — cuántos fotogramas extraer (fps o todos), la
   cuadrícula (columnas × filas = imágenes por hoja), **qué fotogramas incluir o
   excluir** (p. ej. `1, 3-5`) y el espaciado entre frames.
3. **Hoja** — tamaño (A4 u otro), **orientación** (vertical, horizontal o mejor
   ajuste automático), DPI (300 = calidad de impresión), margen y color de fondo.
4. **Nombres de frames** — nombre base (por defecto el del video), separador,
   ceros a la izquierda, número inicial, fuente, tamaño y margen entre el frame y
   su nombre.
5. **Numerador de hoja** — número de hoja en la esquina que elijas, con ceros a
   la izquierda configurables.
6. **Salida** — carpeta, nombre de archivo y formatos (PNG / PDF / TIFF).

Usa **«👁 Vista previa»** para ver todas las hojas (puedes navegar entre ellas)
antes de generar. Luego pulsa **«Generar contact sheets»**. Abajo verás una
estimación de cuántos fotogramas y hojas saldrán, y una barra de progreso.

---

## 🎨 Sobre la calidad y el color

- Los fotogramas se extraen a **PNG**, un formato **sin pérdida**: no se
  recomprime ni se degrada la imagen.
- **No se aplica ningún filtro de color, recorte ni corrección.** El único paso
  inevitable es la conversión interna de YUV (cómo guarda el color el video) a RGB
  (cómo se muestran las imágenes), que es exactamente lo que hace cualquier
  reproductor; no es una alteración del color.
- Las hojas se componen a alta resolución (DPI configurable) y los frames se
  reescalan con remuestreo **LANCZOS** (alta calidad) solo para encajar en cada
  celda, conservando su relación de aspecto.

---

## 🔧 Para quien sí quiera la terminal (opcional)

> En macOS el comando suele ser `python3` (no `python`). En Windows, `py`.

```bash
python3 -m pip install -r requirements.txt
python3 -m kamiru          # abre la app
```

No hace falta instalar `ffmpeg` aparte: viene incluido vía `imageio-ffmpeg`.

### ¿La ventana se abre en blanco (macOS)?

Es el **Tk 8.5** obsoleto que trae macOS de fábrica; dibuja la ventana vacía.
Solución: usa el **Python de [python.org](https://www.python.org/downloads/)**
(incluye un Tk 8.6 que sí funciona). Los lanzadores ya lo eligen
automáticamente y, si detectan un entorno viejo, lo recrean solos. Si lo
arreglas a mano, borra el entorno y vuelve a abrir:

```bash
rm -rf .venv
./run.command   # o doble clic
```

---

## 📦 Qué hay dentro

```
kamiru/                          El código de la app (paquete Python)
  app.py          La ventana (interfaz gráfica con Tkinter)
  core.py         Composición de los contact sheets (Pillow)
  ffmpeg_utils.py Extracción de fotogramas y lectura del video (ffmpeg)
  paper.py        Tamaños de hoja y conversiones mm/px
  fonts.py        Búsqueda de fuentes del sistema
  config.py       Guarda/recuerda tus ajustes
Video to Contact Sheets.app      App de macOS (doble clic, sin terminal)
Abrir Video to Contact Sheets.vbs  App de Windows (doble clic, sin consola)
Instalar en Linux.sh             Registra la app en Linux (ejecutar una vez)
assets/icon.png · icon.ico       Ícono de la app
run.command / run.bat / run.sh   Lanzadores por terminal (alternativa)
main.py           Alternativa: python3 main.py
requirements.txt  Dependencias (Pillow, imageio-ffmpeg)
```

---

Hecho con cariño. 💚
