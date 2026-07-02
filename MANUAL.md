# 📖 Manual de Kamiru Studio

*La guía completa, paso a paso, para usar la app sin conocimientos técnicos.*

---

## Índice

1. [¿Qué hace esta app?](#1-qué-hace-esta-app)
2. [Instalación (solo la primera vez)](#2-instalación-solo-la-primera-vez)
3. [Conceptos en 1 minuto](#3-conceptos-en-1-minuto)
4. [Fase ① — Generar hojas](#4-fase--generar-hojas)
5. [El trabajo físico: imprimir, pintar, escanear](#5-el-trabajo-físico-imprimir-pintar-escanear)
6. [Fase ② — Procesar escaneos](#6-fase--procesar-escaneos)
7. [Modo cianotipia ☀️](#7-modo-cianotipia-)
8. [Fase ③ — Calibración](#8-fase--calibración)
9. [Fase ④ — Video final](#9-fase--video-final)
10. [Recetas rápidas](#10-recetas-rápidas)
11. [Solución de problemas](#11-solución-de-problemas)
12. [Consejos de rendimiento](#12-consejos-de-rendimiento)

---

## 1. ¿Qué hace esta app?

Kamiru Studio automatiza todo tu flujo de animación *mixed media* y de
*cianotipia*, sin Photoshop:

```
①  La app convierte tu video en HOJAS imprimibles
    (una cuadrícula de fotogramas por hoja, con marcadores en los bordes
     y un código QR bajo cada fotograma)
        │
✋  Tú imprimes las hojas, pintas sobre los fotogramas
☀️  …o imprimes NEGATIVOS en acetato y expones cianotipias al sol
        │
📠  Escaneas todas las hojas (da igual el orden, la rotación o la resolución)
        │
②  La app endereza cada escaneo con los marcadores, lee los QR para saber
    qué hoja es, y recorta cada fotograma perfecto, con su nombre correcto
        │
④  La app vuelve a unir los fotogramas en un VIDEO
```

La ventana tiene **4 pestañas grandes** (fases), en el orden del flujo:
**① Generar hojas · ② Procesar escaneos · ③ Calibración · ④ Video final**.

---

## 2. Instalación (solo la primera vez)

### La forma fácil: descarga el ejecutable (recomendada)

1. Entra a la página de **Releases** del repositorio en GitHub.
2. Descarga el archivo de tu sistema:
   - **Windows**: `Kamiru-Studio-windows.zip` → descomprime la carpeta donde
     quieras y abre `Kamiru-Studio.exe`. (Si SmartScreen avisa: «Más
     información» → «Ejecutar de todas formas».)
   - **macOS con chip Apple (M1–M4)**: `Kamiru-Studio-macos-apple-silicon.zip`
     → descomprime y abre `Kamiru-Studio.app`. La primera vez: **clic
     derecho → Abrir → Abrir** (es una app sin firmar).
   - **Linux**: `Kamiru-Studio-linux.tar.gz` → descomprime y ejecuta
     `Kamiru-Studio/Kamiru-Studio`.
3. Listo. **No hace falta instalar Python, ni git, ni nada.**

### La forma clásica: desde el código

1. Instala **Python 3** desde <https://www.python.org/downloads/>
   (en Windows, marca la casilla **"Add Python to PATH"**).
2. Abre la app:
   - **macOS**: doble clic en `Video to Contact Sheets.app`
     (primera vez: clic derecho → Abrir → Abrir).
     ⚠️ Guarda la carpeta **fuera** de Documentos/Escritorio/Descargas.
   - **Windows**: doble clic en `Abrir Video to Contact Sheets.vbs`.
   - **Linux**: ejecuta una vez `./Instalar en Linux.sh` y ábrela del menú.
3. La primera vez tarda 2–3 minutos instalando sus dependencias. Después
   abre al instante.

La app **recuerda todos tus ajustes** al cerrarla. Además puedes guardar
**presets** con nombre (abajo a la izquierda en la fase ①): por ejemplo un
preset "MXM 2×2" y otro "Cianotipia A4".

---

## 3. Conceptos en 1 minuto

- **Marcadores ArUco**: los cuadraditos en blanco y negro del borde de la
  hoja. Sirven para que la app enderece el escaneo con precisión matemática.
  Se ponen **8** (o 12): aunque varios se manchen, se tapen o se corten,
  **con 3 sanos alcanza**.
- **Código QR**: va debajo de cada fotograma y dice "soy el fotograma X de la
  hoja Y del proyecto Z". Con **un solo QR legible** en la hoja, la app ya
  sabe qué hoja es. Puedes escanear las hojas en cualquier orden.
- **`layout.json`**: un archivito que se guarda junto a las hojas generadas.
  Es el **mapa** con las coordenadas exactas de todo. La fase ② lo necesita.
  **No lo borres ni lo edites.** (Si usas varias tandas, cada una tiene el
  suyo: `nombre_layout.json`.)
- **Bleed (sangrado)**: cuánto se recorta "hacia adentro" cada fotograma al
  procesarlo, para que no queden bordes de papel blanco. Se ajusta en %.
- **Perfil**: el resultado de una calibración (fase ③), guardado con nombre.
  Hay perfiles de **impresora** y de **cianotipia**.

---

## 4. Fase ① — Generar hojas

### Pestaña 1 · Origen
- **De un video**: elige el archivo. La app muestra duración/resolución/fps.
  Puedes procesar todo el video o un rango en segundos.
- **De una carpeta de imágenes**: para frames ya exportados (TIFF/PNG/JPG…).

### Pestaña 2 · Fotogramas
- **Cuántos extraer** (solo video): N por segundo (admite decimales:
  `0.5` = uno cada 2 s) o **TODOS** (mixed media).
- **Cuadrícula**: columnas × filas = imágenes por hoja.
  Para mixed media clásico: **2 × 2**.
- **Incluir/excluir**: por posición, ej. `1, 3-5`. Excluir gana.
- **Dibujos repetidos** 🆕: activa la detección para que los fotogramas
  idénticos (dibujos sostenidos, ciclos) **se impriman una sola vez**.
  Al armar el video (fase ④) se reutilizan solos en todas sus posiciones.
  Tolerancia 4 recomendada; 0 = solo idénticos exactos.

### Pestaña 3 · Hoja
- Tamaño de hoja, orientación y **DPI** (300 = imprenta), margen y color de
  fondo. El **"mejor ajuste"** prueba vertical/horizontal **y también la
  cuadrícula intercambiada** (p. ej. 4×5 ↔ 5×4, misma cantidad por hoja) y
  elige la combinación que deja los fotogramas más grandes — siempre igual o
  mejor que eligiendo a mano. Si intercambió la cuadrícula, te lo dice al
  terminar.
- **Perfil de impresora**: si ya calibraste (fase ③), elígelo aquí. La app
  compensará la escala real de tu impresora y con el botón
  *"Aplicar tamaños recomendados"* usará los tamaños de marcador/QR que se
  midieron como seguros.

### Pestaña 4 · Nombres
- Cada fotograma lleva su nombre debajo: nombre base + separador + número
  (`abc_001`) **o el nombre del archivo original** (útil con carpetas).
- Numeración **continua** (1,2,3…) u **original** (posición real en el video,
  para no perder el orden al incluir/excluir).
- Fuente, tamaño, color, y margen entre frame y texto.

### Pestaña 5 · Nº de hoja
- Numerador en la esquina que quieras, con prefijo ("Hoja ") y ceros
  (`Hoja 001`), continuo u original.

### Pestaña 6 · Marcadores  ← **actívala si vas a escanear de vuelta**
- **Añadir marcadores ArUco + QR**: imprescindible para la fase ②.
  Genera además el `layout.json`.
- **Cantidad**: 8 recomendado (funciona aunque fallen hasta 5).
  12 si sueles pintar muy al borde.
- **Tamaño**: 8 mm por defecto. Si calibras tu impresora, usa el recomendado.
- **QR**: 10-12 mm. El "nombre del proyecto" viaja dentro de cada QR.
- **Tira de parches de grises** (opcional): permite normalizar niveles del
  escáner en la fase ② (apagado por defecto: no se toca el color).

### Pestaña 7 · Cianotipia
Ver la [sección 7](#7-modo-cianotipia-).

### Pestaña 8 · Salida
- Carpeta, nombre, formatos (**PNG** y/o **TIFF** por hoja + **PDF combinado**
  ideal para mandar a imprimir).
- **Guardar copia de los fotogramas originales**: déjalo activado; es lo que
  permite las **hojas de rescate** después.
- **Qué hojas producir** 🆕: ej. `3, 5-7` regenera solo esas hojas
  (el layout sigue describiendo todas). Perfecto si se dañó una hoja o
  cambiaste de opinión sobre cuáles imprimir.

### Vista previa 👁
El botón **Vista previa** muestra todas las hojas navegables (flechas del
teclado) tal como saldrán: con marcadores, QRs y, en modo cianotipia, el
negativo o una **simulación de la copia azul** (pestaña 7).

Cuando todo te guste: **Generar hojas** 🎉. Al terminar, la app rellena sola
el layout en las fases ② y ④.

---

## 5. El trabajo físico: imprimir, pintar, escanear

### Imprimir
- Imprime **al 100 %**: en el diálogo de impresión desactiva
  **"ajustar a página" / "fit to page"**. (Si tu impresora escala sin
  permiso, la calibración de la fase ③ lo compensa.)
- Papel y DPI: los mismos que configuraste.

### Pintar (mixed media)
1. Cubre con **cinta de enmascarar** los marcadores de los bordes y los QRs.
2. Pinta con libertad; puedes salirte un poco de los bordes del fotograma.
3. Retira la cinta con cuidado antes de escanear.
4. ¿Se dañó un marcador o un QR? **No pasa nada**: sobran marcadores y con un
   QR legible por hoja alcanza. Y si todo falla, están las hojas de rescate.

### Escanear
- **Formato**: TIFF (ideal) o PNG. JPG también sirve.
- **Resolución**: la que quieras (600–1200 PPI recomendado para pintura).
  La app **mide la escala real sola**, no asume nada.
- **Color**: RGB. **16 bits por canal si tu escáner puede** (se conservan).
- **Orden y orientación**: da igual. Rotadas o de cabeza, se procesan igual.
- Guarda todos los escaneos de una tanda en **una carpeta**.

---

## 6. Fase ② — Procesar escaneos

1. **Carpeta con los escaneos**: la de arriba.
2. **Archivo layout (.json)**: el que se generó junto a las hojas
   (la app lo rellena sola si generaste en esta sesión).
3. **Carpeta de salida**: donde caerán los fotogramas recuperados.
4. Opciones:
   - **Bleed** (1.5 % por defecto): sube si ves bordes de papel, baja si se
     come mucho dibujo.
   - **Marcadores mínimos** (3): cuántos hacen falta para aceptar una hoja.
   - **Escaneos en paralelo**: 2–4 normal; en tu PC potente puedes subir a
     6–8 (ver [rendimiento](#12-consejos-de-rendimiento)).
   - **Tipo de hoja**: en "Automático" la app usa lo que dice el layout
     (normal o cianotipia).
   - **Reescalar al tamaño original**: activa si quieres los fotogramas
     exactamente a la resolución digital de origen (ej. 4K). Apagado conserva
     toda la resolución del escáner.
5. **Procesar escaneos**. El log muestra hoja por hoja qué pasó.

### El informe
Al terminar se guarda en la carpeta de salida:
- `informe.html` — ábrelo en el navegador: tabla con cada escaneo, cuántos
  marcadores se detectaron, y **miniaturas de cada fotograma recuperado**.
- `informe.json` / `informe.csv` — datos para la app y para hojas de cálculo.

### Hojas de rescate 🛟
Si faltan fotogramas (QR pintado, hoja perdida…), pulsa
**"Generar hojas de rescate"**: se crean hojas nuevas SOLO con los fotogramas
fallidos (numeradas con prefijo "R"), usando los mismos ajustes y las copias
originales guardadas. Imprímelas, píntalas/exponlas, escanéalas y procésalas
apuntando al layout `*_rescate_layout.json`, con la **misma carpeta de
salida**: los fotogramas se completan ahí.

### Carpeta `sin_identificar/`
Si una hoja se alineó bien pero **ningún** QR fue legible, sus recortes se
guardan igualmente ahí (nombrados por escaneo y celda) para que no pierdas el
arte: puedes renombrarlos a mano.

---

## 7. Modo cianotipia ☀️

### La idea
Para cianotipia no se imprime la imagen: se imprime su **NEGATIVO en un
acetato transparente**. Al poner el acetato en contacto con el papel
emulsionado y exponerlo al sol, la luz UV pasa por las zonas transparentes
(→ azul de Prusia) y se bloquea en las zonas con tinta (→ blanco papel).

Kamiru Studio hace todo el trabajo raro por ti. Con el **modo cianotipia**
activado (fase ①, pestaña 7):

- Cada hoja sale como **negativo**: imágenes invertidas y los **marcadores,
  QRs y nombres también invertidos** — así, en la copia azul final, todo queda
  con la polaridad normal y la fase ② la procesa como cualquier hoja.
- **Fondo del negativo (consumo de tinta)**, a elegir:
  - **AHORRO DE TINTA** (por defecto): las zonas muertas quedan
    **transparentes** (sin tinta) y solo los marcadores, QRs y nombres llevan
    un **halo entintado** (margen configurable, 3 mm por defecto) para
    distinguirse. En la copia azul el fondo queda **azul** y cada marcador/QR
    flota en su islita blanca. Gasta una fracción de la tinta.
  - **Fondo COMPLETO**: toda la zona muerta va entintada; en la copia azul el
    fondo queda **blanco papel** (como una hoja normal). Bonito, pero carísimo
    en tinta.
- **Espejado** (activado por defecto): el negativo se imprime en espejo para
  exponer "cara impresa contra papel" (más nitidez). La copia azul queda
  derecha sola.
- **Color de tinta**: negro por defecto, PERO el negro no siempre es lo que
  mejor bloquea el UV. La carta **EDN ColorBlocker** (fase ③) mide qué color
  bloquea mejor en TU impresora y crea un **perfil de color** (con degradado
  de 3 paradas). Si eliges un perfil de color en la pestaña 7, reemplaza al
  color simple.
- **Curva de compensación**: la joya. La química de la cianotipia no responde
  de forma lineal; sin corrección, los medios tonos se aplastan. La curva se
  crea con la calibración (fase ③, tira Kamiru o carta EDN 2.2) y se aplica
  sola al generar los negativos. Si generas negativos sin curva, la app te
  ofrece crear la hoja de calibración primero.

### Receta completa de cianotipia
1. **(Una vez, opcional pero muy recomendado)** Fase ③ → carta
   **EDN ColorBlocker** → imprímela en acetato → cianotipia → escanea → analiza
   → guarda el **perfil de color** (descubre tu mejor tinta).
2. **(Una vez)** Fase ③ → carta de curva (**tira Kamiru** o **EDN 2.2 de 256
   tonos**), con tu perfil de color elegido → imprime en acetato → cianotipia
   → escanea la copia azul seca → analiza → guarda el **perfil de curva**.
3. Fase ① → pestaña 7: activa **modo cianotipia**, elige **fondo ahorro o
   completo**, tu **perfil de color** y tu **curva**. Marcadores activados
   (pestaña 6).
4. Genera las hojas → imprímelas en **acetato** al 100 %.
5. Expón tus cianotipias al sol, revela, lava y **seca**.
6. **Escanea las copias azules** (no los acetatos) → fase ② en modo
   "Automático" → fotogramas azules perfectos → fase ④ → video de cianotipia.

> 💡 La app tolera la **variabilidad de tonos** del azul (exposiciones
> distintas, lavados distintos): la detección usa el canal rojo del escaneo,
> donde el azul de Prusia es casi negro, más mejora local de contraste. Aun
> así, intenta escanear las copias bien secas y planas.

> ⚠️ Escanea la **copia azul**, no el acetato: el acetato está espejado y sus
> marcadores no son detectables (es lo esperado).

---

## 8. Fase ③ — Calibración

### Impresora 🖨
1. Elige papel y DPI → **Generar página de prueba** → imprímela **al 100 %**.
2. Escanéala completa (anota el DPI del escaneo si tu escáner no lo guarda).
3. **Analizar escaneo**. La app mide:
   - **Escala real** de impresión (¿tu impresora encoge la página un 3 %?).
     Con el perfil activo, la fase ① lo compensa automáticamente.
   - **Respuesta tonal** (cómo salen los grises).
   - **Tamaño mínimo fiable de marcador ArUco y de QR** para TU combinación
     impresora+escáner, con recomendación de tamaño seguro.
4. Ponle nombre y **Guardar perfil** → aparece en la fase ①, pestaña Hoja.

### Cianotipia ☀️

Elige primero la **carta** en el desplegable:

| Carta | Para qué sirve |
|---|---|
| **Tira Kamiru (21 parches)** | Curva de compensación rápida. Ideal para empezar. |
| **Carta EDN 2.2 (256 tonos)** | Curva de compensación FINA con los 256 valores, según el método [Easy Digital Negatives](http://www.easydigitalnegatives.com/) de Peter Mrhar. Aquí viene con el marco de marcadores de Kamiru: el análisis del escaneo es automático (no hay que recortar ni subir nada a ninguna web). |
| **EDN ColorBlocker 3** | Descubre **qué color de tinta bloquea mejor el UV** en tu impresora (36 matices × 21 variantes + grises). Produce un **perfil de color** con el mejor color y un degradado de 3 paradas. |

El flujo es el mismo para las tres:
1. Elige color de tinta/perfil de color y espejado (los MISMOS que usarás de
   verdad) → **Generar carta de calibración** → imprímela en acetato al 100 %
   en calidad máxima.
2. Haz la cianotipia de esa carta exactamente con tu proceso normal.
3. Escanea la copia azul seca → **Analizar cianotipia**. Según la carta, la
   app construye la **curva de compensación** (con rango dinámico y
   sugerencias) o el **perfil de color** (mejor bloqueador + degradado).
4. **Guardar perfil** → aparece en la fase ①, pestaña Cianotipia.

Orden recomendado: primero el **ColorBlocker** (una vez, para conocer tu mejor
tinta) y después la **curva** (tira Kamiru o EDN 2.2) usando ese perfil de
color, para que la curva mida tu proceso real completo.

> Recalibra si cambias de impresora, tinta, acetato, papel, química o si la
> luz de tu proceso cambia mucho (verano/invierno).

---

## 9. Fase ④ — Video final

1. **Layout (.json)** del proyecto (se rellena solo tras procesar).
2. **Carpeta con los fotogramas procesados** (la salida de la fase ②).
3. **fps**: se lee del proyecto; cámbialo si quieres otro ritmo.
4. **Códec**:
   - *MP4 (H.264)* — para compartir, compatible con todo.
   - *MP4 (H.264 4:4:4)* — máxima calidad de color en H.264.
   - *MOV (ProRes 422 HQ)* — para seguir editando en DaVinci/Premiere.
5. **Crear video** 🎬.

La línea de tiempo respeta el orden original del video y **repite los
fotogramas deduplicados** en todas sus posiciones. Si faltan fotogramas, la
app te avisa y arma el video con los disponibles.

> ¿Prefieres editar tú? Los fotogramas procesados son TIFFs numerados que
> puedes importar directamente en DaVinci Resolve como secuencia.

---

## 10. Recetas rápidas

### Mixed media clásico (pintar sobre papel)
> ① Origen: video → Fotogramas: TODOS + cuadrícula 2×2 + duplicados ON →
> Hoja: A4 300 DPI + perfil de impresora → Marcadores: ON (8) →
> Salida: TIFF + PDF → imprimir → cinta → pintar → escanear 1200 PPI 16 bits →
> ② procesar → ④ video ProRes.

### Cianotipia
> ③ calibrar cianotipia (una vez) → ① origen + cuadrícula deseada +
> Marcadores ON + Cianotipia ON (curva + espejo) → imprimir en acetato →
> exponer al sol → escanear las copias azules → ② procesar (auto) →
> ④ video.

### Reimprimir una sola hoja dañada
> ① Salida → "Generar solo las hojas: 5" → Generar. (Mismos ajustes ⇒ misma
> geometría; su escaneo se procesa con el layout de siempre.)

### Contact sheets "de toda la vida" (solo para archivar)
> Igual que la v1: Marcadores OFF, cuadrícula 4×5, PDF combinado. Listo.

---

## 11. Solución de problemas

**"Solo se detectaron X de 8 marcadores"**
- ¿La hoja completa está en el escaneo, con sus 4 bordes?
- ¿Quedó cinta o pintura sobre demasiados marcadores? (Bastan 3 sanos.)
- ¿Es una cianotipia muy pálida? Prueba tipo de hoja = "Cianotipia" y revisa
  la exposición; recalibra si es sistemático.
- Puedes bajar "marcadores mínimos" a 2 (menos precisión de alineación).

**"QRs ilegibles: no se pudo identificar la hoja"**
- Los recortes están en `sin_identificar/`: renómbralos a mano.
- Para la próxima: QRs de 12 mm, cúbrelos bien con cinta al pintar, y usa la
  calibración para conocer el tamaño mínimo fiable de tu impresora.

**Bordes blancos alrededor de los fotogramas recuperados** → sube el bleed
(2–2.5 %). **Se come el dibujo** → baja el bleed (0.5–1 %).

**Los colores del escaneo se ven raros en el visor** → abre los TIFF en
DaVinci/Photoshop (respetan perfiles ICC). La app no toca el color.

**La cianotipia sale muy plana (poco contraste)** → mira el "rango dinámico"
de la calibración: si es bajo, más exposición, tinta más densa (calidad
máxima de impresión, o color de tinta más bloqueador) o revisa el lavado.

**La impresora corta los marcadores del borde** → sube el "margen al borde"
de los marcadores (pestaña 6) por encima del área no imprimible de tu
impresora (usualmente ≥ 5 mm).

**Windows: rutas con tildes/ñ** → soportadas. **macOS: "Operation not
permitted"** → mueve la carpeta de la app fuera de Documentos/Escritorio/
Descargas.

**El video final no abre en algún reproductor** → usa el códec "compatible
con todo"; el 4:4:4 y ProRes son para edición.

---

## 12. Consejos de rendimiento

La app está pensada para aprovechar máquinas potentes:

- **Escaneos en paralelo** (fase ②): cada escaneo grande (1200 PPI, 16 bits)
  usa ~2–3 GB de RAM mientras se procesa.
  - PC con 48 GB (Ryzen 9900X): 6–8 en paralelo van sobrados.
  - MacBook M4 Max con 32 GB: 4–6.
  - Si la máquina se queda sin memoria, baja el número: es la primera palanca.
- **DPI de escaneo**: 1200 PPI da recortes enormes y hermosos; la app los
  maneja bien, pero el disco se llena rápido (50–150 MB por hoja). 600 PPI es
  un buen equilibrio para pintura; para cianotipia suele bastar 600.
- La **vista previa** renderiza a baja resolución: siempre es rápida aunque
  el proyecto sea gigante.
- La extracción de fotogramas y la codificación del video usan ffmpeg, que ya
  aprovecha todos los núcleos.

---

*Hecho con cariño para Kamila 💚 — si algo no se entiende, es culpa del
manual, no tuya: pide que lo mejoren.*
