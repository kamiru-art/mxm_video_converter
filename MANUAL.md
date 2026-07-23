# 📖 Manual de Kamiru Studio

*La guía completa, paso a paso, para usar la app sin conocimientos técnicos.*

---

## Índice

1. [¿Qué hace esta app?](#1-qué-hace-esta-app)
2. [Instalación (solo la primera vez)](#2-instalación-solo-la-primera-vez)
3. [Conceptos en 1 minuto](#3-conceptos-en-1-minuto)
4. [Fase ① — Calibración (empieza aquí)](#4-fase--calibración-empieza-aquí)
5. [Fase ② — Generar hojas](#5-fase--generar-hojas)
6. [El trabajo físico: imprimir, pintar, escanear](#6-el-trabajo-físico-imprimir-pintar-escanear)
7. [Fase ③ — Procesar escaneos](#7-fase--procesar-escaneos)
8. [Modo cianotipia ☀️](#8-modo-cianotipia-)
9. [Fase ④ — Video final](#9-fase--video-final)
10. [Recetas rápidas](#10-recetas-rápidas)
11. [Solución de problemas](#11-solución-de-problemas)
12. [Consejos de rendimiento](#12-consejos-de-rendimiento)

---

## 1. ¿Qué hace esta app?

Kamiru Studio automatiza todo tu flujo de animación *mixed media* y de
*cianotipia*, sin Photoshop:

```
①  (Una sola vez) CALIBRAS tu impresora y tu proceso de cianotipia
    (la app mide cómo imprime y cómo responde tu química, y lo compensa)
        │
②  La app convierte tu video en HOJAS imprimibles
    (una cuadrícula de fotogramas por hoja, con marcadores en los bordes
     y un código QR bajo cada fotograma)
        │
✋  Tú imprimes las hojas, pintas sobre los fotogramas
☀️  …o imprimes NEGATIVOS en acetato y expones cianotipias al sol
        │
📠  Escaneas todas las hojas (da igual el orden, la rotación o la resolución)
        │
③  La app endereza cada escaneo con los marcadores, lee los QR para saber
    qué hoja es, y recorta cada fotograma perfecto, con su nombre correcto
        │
④  La app vuelve a unir los fotogramas en un VIDEO
```

La ventana tiene **4 pestañas grandes** (fases), en el orden del flujo:
**① Calibración · ② Generar hojas · ③ Procesar escaneos · ④ Video final**.
Cada sección importante tiene un botón **«?»** que abre una guía visual
paso a paso: si dudas, púlsalo.

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
**presets** con nombre (abajo a la izquierda en la fase ②): por ejemplo un
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
  Es el **mapa** con las coordenadas exactas de todo. La fase ③ lo necesita.
  **No lo borres ni lo edites.** (Si usas varias tandas, cada una tiene el
  suyo: `nombre_layout.json`.)
- **Bleed (sangrado)**: cuánto se recorta "hacia adentro" cada fotograma al
  procesarlo, para que no queden bordes de papel blanco. Se ajusta en %.
- **Perfil**: el resultado de una calibración (fase ①), guardado con nombre.
  Hay perfiles de **impresora** y de **cianotipia**.

---

## 4. Fase ① — Calibración (empieza aquí)

### ¿Por qué calibrar PRIMERO?

Porque **todo lo demás usa los resultados**. La fase ② te pedirá un perfil de
impresora (pestaña Hoja) y, si haces cianotipia, un perfil de color y una
curva (pestaña Cianotipia). Si calibras al principio, esos desplegables ya
tendrán tus perfiles y no habrá que volver atrás.

Es trabajo de **una sola vez** (por impresora, y por proceso de cianotipia):

- La **impresora** miente en dos cosas: escala la página un poco (2-4 % es
  normal) y aplasta tonos. El perfil lo mide y la app lo compensa al generar
  cada hoja. También descubre el **tamaño mínimo** de marcador ArUco y de QR
  que TU combinación impresora+escáner reproduce de forma fiable.
- La **cianotipia** no responde de forma lineal a la tinta del negativo: sin
  curva, los medios tonos se aplastan y las copias salen chatas. La curva se
  mide con TU proceso completo real: tu impresora + tu acetato + tu emulsión
  + tu sol + tu lavado.

> 💡 En la app, cada sección de calibración tiene un botón **«?»** con esta
> misma guía paso a paso, siempre a un clic.
>
> ¿Solo quieres probar la app o pintar sobre papel sin escanear de vuelta?
> Puedes saltarte esta fase y volver cuando quieras precisión.

### Impresora 🖨 (paso a paso)

1. **Genera la página de prueba**: elige papel y DPI (los mismos que usarás
   para tus hojas) → **Generar página de prueba**. Se guarda un PNG/TIFF.
2. **Imprímela al 100 %**: en el diálogo de impresión desactiva «ajustar a
   página»/«fit to page». Es el paso donde más gente se equivoca.
3. **Escanéala completa** (los 4 bordes visibles), a 300 DPI o más. Si tu
   escáner no guarda el DPI en el archivo, anótalo y escríbelo en la casilla
   «DPI del escaneo».
4. **Analizar escaneo**. La app mide:
   - **Escala real** de impresión (¿tu impresora encoge la página un 3 %?).
     Con el perfil activo, la fase ② lo compensa automáticamente.
   - **Respuesta tonal** (cómo salen los grises).
   - **Tamaño mínimo fiable de marcador ArUco y de QR** para TU combinación
     impresora+escáner, con recomendación de tamaño seguro.
5. Ponle nombre y **Guardar perfil** → aparece en la fase ②, pestaña Hoja,
   junto con el botón «Aplicar tamaños recomendados».

### Cianotipia ☀️

Elige primero la **carta** en el desplegable:

| Carta | Para qué sirve |
|---|---|
| **Tira Kamiru (21 parches)** | Curva de compensación rápida. Ideal para empezar. |
| **Carta EDN 2.2 (256 tonos)** | Curva de compensación FINA con los 256 valores, según el método [Easy Digital Negatives](http://www.easydigitalnegatives.com/) de Peter Mrhar. Aquí viene con el marco de marcadores de Kamiru: el análisis del escaneo es automático (no hay que recortar ni subir nada a ninguna web). |
| **EDN ColorBlocker 3** | Descubre **qué color de tinta bloquea mejor el UV** en tu impresora (36 matices × 21 variantes + grises). Produce un **perfil de color** con el mejor color y un degradado de 3 paradas. |

El flujo es el mismo para las tres (paso a paso):

1. **Genera la carta**: elige color de tinta/perfil de color y espejado (los
   MISMOS que usarás de verdad) → **Generar carta de calibración**.
2. **Imprímela en ACETATO al 100 %**, en la calidad más alta de tu impresora
   (más tinta = mejor bloqueo del UV). La carta sale en espejo: es correcto.
3. **Haz la cianotipia de esa carta exactamente con tu proceso normal**:
   acetato con la tinta CONTRA el papel emulsionado, tu tiempo de exposición
   habitual, revelado, buen lavado… y **secado completo** (el azul se oscurece
   al secar: medir húmedo falsea la curva).
4. **Escanea la copia azul seca** (NO el acetato), completa y plana.
5. **Analizar cianotipia**. Según la carta, la app construye la **curva de
   compensación** (con rango dinámico y sugerencias) o el **perfil de color**
   (mejor bloqueador + degradado).
6. **Guardar perfil** → aparece en la fase ②, pestaña Cianotipia.

Orden recomendado: primero el **ColorBlocker** (una vez, para conocer tu mejor
tinta) y después la **curva** (tira Kamiru o EDN 2.2) usando ese perfil de
color, para que la curva mida tu proceso real completo.

> 💡 **Curva suave, sin escalones**: la curva se construye con suavizado +
> regresión isotónica + interpolación monótona (estilo Easy Digital
> Negatives), y al generar los negativos se aplica con un difuminado fino
> (dithering). Resultado: degradados continuos en la copia, sin los saltos
> "de escalera" que produce una curva cruda medida con ruido.

> Recalibra si cambias de impresora, tinta, acetato, papel, química o si la
> luz de tu proceso cambia mucho (verano/invierno).

---

## 5. Fase ② — Generar hojas

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
- **Perfil de impresora**: si ya calibraste (fase ①), elígelo aquí. La app
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
- **Añadir marcadores ArUco + QR**: imprescindible para la fase ③.
  Genera además el `layout.json`.
- **Cantidad**: 8 recomendado (funciona aunque fallen hasta 5).
  12 si sueles pintar muy al borde.
- **Tamaño**: 8 mm por defecto. Si calibras tu impresora, usa el recomendado.
- **QR**: 10-12 mm. El "nombre del proyecto" viaja dentro de cada QR.
- **Tira de parches de grises** (opcional): permite normalizar niveles del
  escáner en la fase ③ (apagado por defecto: no se toca el color).

### Pestaña 7 · Cianotipia
Ver la [sección 8](#8-modo-cianotipia-).

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
el layout en las fases ③ y ④.

---

## 6. El trabajo físico: imprimir, pintar, escanear

### Imprimir
- Imprime **al 100 %**: en el diálogo de impresión desactiva
  **"ajustar a página" / "fit to page"**. (Si tu impresora escala sin
  permiso, la calibración de la fase ① lo compensa.)
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

## 7. Fase ③ — Procesar escaneos

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

## 8. Modo cianotipia ☀️

### La idea
Para cianotipia no se imprime la imagen: se imprime su **NEGATIVO en un
acetato transparente**. Al poner el acetato en contacto con el papel
emulsionado y exponerlo al sol, la luz UV pasa por las zonas transparentes
(→ azul de Prusia) y se bloquea en las zonas con tinta (→ blanco papel).

Kamiru Studio hace todo el trabajo raro por ti. Con el **modo cianotipia**
activado (fase ②, pestaña 7):

- Cada hoja sale como **negativo**: imágenes invertidas y los **marcadores,
  QRs y nombres también invertidos** — así, en la copia azul final, todo queda
  con la polaridad normal y la fase ③ la procesa como cualquier hoja.
- **Fondo del negativo (consumo de tinta)**, a elegir:
  - **AHORRO DE TINTA** (por defecto): las zonas muertas quedan
    **transparentes** (sin tinta) y solo los marcadores, QRs y nombres llevan
    un **halo entintado** (margen configurable, 5 mm por defecto) para
    distinguirse. En la copia azul el fondo queda **azul** y cada marcador/QR
    flota en su islita blanca. Gasta una fracción de la tinta.
  - **Fondo COMPLETO**: toda la zona muerta va entintada; en la copia azul el
    fondo queda **blanco papel** (como una hoja normal). Bonito, pero carísimo
    en tinta.
- **Espejado** (activado por defecto): el negativo se imprime en espejo para
  exponer "cara impresa contra papel" (más nitidez). La copia azul queda
  derecha sola.
- **Borde bloqueador** 🆕 (0.8 mm por defecto, regulable 0–1 mm): un marco
  fino de tinta a densidad MÁXIMA alrededor de cada fotograma, por fuera de
  la imagen. Evita que la luz se cuele por los cantos del acetato durante la
  exposición y vele los bordes. Usa automáticamente tu color/degradado
  ColorBlocker si hay perfil elegido. Ponlo en 0 para desactivarlo.
- **Color del bloqueador** 🆕: todo lo externo a los fotogramas (fondo
  completo, halos y borde bloqueador) se imprime por defecto con la tinta a
  densidad máxima — con un degradado ColorBlocker, negro puro. Si tu
  impresora imprime mal los campos grandes de negro 100 % (bandas), activa
  «Color del bloqueador personalizado» y elige un color denso que sí imprima
  bien: solo tiene que bloquear el UV, no afecta a los tonos de las
  imágenes. La misma opción existe en la fase ① para el fondo de las cartas
  de calibración («Color del fondo de la carta»).
- **Color de tinta**: negro por defecto, PERO el negro no siempre es lo que
  mejor bloquea el UV. La carta **EDN ColorBlocker** (fase ①) mide qué color
  bloquea mejor en TU impresora y crea un **perfil de color** (con degradado
  de 3 paradas). Si eliges un perfil de color en la pestaña 7, reemplaza al
  color simple.
- **Curva de compensación**: la joya. La química de la cianotipia no responde
  de forma lineal; sin corrección, los medios tonos se aplastan. La curva se
  crea con la calibración (fase ①, tira Kamiru o carta EDN 2.2) y se aplica
  sola al generar los negativos. Si generas negativos sin curva, la app te
  ofrece crear la hoja de calibración primero.

### Receta completa de cianotipia
1. **(Una vez, opcional pero muy recomendado)** Fase ① → carta
   **EDN ColorBlocker** → imprímela en acetato → cianotipia → escanea → analiza
   → guarda el **perfil de color** (descubre tu mejor tinta).
2. **(Una vez)** Fase ① → carta de curva (**tira Kamiru** o **EDN 2.2 de 256
   tonos**), con tu perfil de color elegido → imprime en acetato → cianotipia
   → escanea la copia azul seca → analiza → guarda el **perfil de curva**.
3. Fase ② → pestaña 7: activa **modo cianotipia**, elige **fondo ahorro o
   completo**, tu **perfil de color** y tu **curva**. Marcadores activados
   (pestaña 6).
4. Genera las hojas → imprímelas en **acetato** al 100 %.
5. Expón tus cianotipias al sol, revela, lava y **seca**.
6. **Escanea las copias azules** (no los acetatos) → fase ③ en modo
   "Automático" → fotogramas azules perfectos → fase ④ → video de cianotipia.

> 💡 La app tolera la **variabilidad de tonos** del azul (exposiciones
> distintas, lavados distintos): la detección usa el canal rojo del escaneo,
> donde el azul de Prusia es casi negro, más mejora local de contraste y un
> **aplanado de fondo** que neutraliza los lavados desiguales (media hoja más
> oscura que la otra). Aun así, intenta escanear las copias bien secas y
> planas.

Refuerzos automáticos de la fase ③ para cianotipia:

- **Copia en espejo**: si expusiste el acetato al revés (tinta hacia arriba),
  la copia sale espejada y los marcadores serían indetectables. La app lo
  detecta, voltea el escaneo sola y lo avisa en el informe. Junto al marcador
  superior-izquierdo se imprime un **triángulo testigo**: en la copia correcta
  apunta a la **derecha**; si apunta a la izquierda, esa hoja se expuso al
  revés (se procesa igual).
- **Marcadores lavados**: los que la primera pasada no ve se re-buscan
  localmente justo donde deberían estar (segunda pasada guiada).
- **Papel deformado**: el papel se moja y encoge; la app mide el **residuo de
  alineación** de cada marcador (sale en el informe, en mm), descarta
  marcadores inconsistentes y corrige cada recorte con los marcadores
  cercanos.
- **Sin QRs legibles**: si el layout tiene una sola hoja, se identifica por
  descarte en vez de ir a `sin_identificar/`.
- **Diagnóstico visual**: el informe incluye una miniatura de alineación por
  escaneo (marcadores detectados en verde, perdidos en rojo, recortes en azul,
  QRs en naranja) para ver de un vistazo dónde falló algo.

Tamaños recomendados para cianotipia (la app avisa si vas por debajo):
**ArUco ≥ 10 mm**, **QR ≥ 12 mm**, margen de marcadores **≥ 6 mm** (los bordes
del papel acumulan manchas de brocha), halo entintado **≥ 4 mm** en modo
ahorro.

> ⚠️ Si actualizaste la app con un proyecto de cianotipia a medio imprimir:
> la geometría de los marcadores en hojas nuevas cambió un poco (zona de
> silencio mayor). Procesa cada hoja con el layout `.json` que se generó
> JUNTO a esa hoja; no mezcles hojas impresas con la versión anterior y un
> layout regenerado con la nueva (ni al revés).

> ⚠️ Escanea la **copia azul**, no el acetato. (Si por error escaneas algo en
> espejo, la app ahora lo corrige sola, pero el acetato sigue sin ser lo que
> quieres medir: escanea siempre el resultado azul.)

---

## 9. Fase ④ — Video final

1. **Layout (.json)** del proyecto (se rellena solo tras procesar).
2. **Carpeta con los fotogramas procesados** (la salida de la fase ③).
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
> ② Origen: video → Fotogramas: TODOS + cuadrícula 2×2 + duplicados ON →
> Hoja: A4 300 DPI + perfil de impresora → Marcadores: ON (8) →
> Salida: TIFF + PDF → imprimir → cinta → pintar → escanear 1200 PPI 16 bits →
> ③ procesar → ④ video ProRes.

### Cianotipia
> ① calibrar cianotipia (una vez) → ② origen + cuadrícula deseada +
> Marcadores ON + Cianotipia ON (curva + espejo) → imprimir en acetato →
> exponer al sol → escanear las copias azules → ③ procesar (auto) →
> ④ video.

### Reimprimir una sola hoja dañada
> ② Salida → "Generar solo las hojas: 5" → Generar. (Mismos ajustes ⇒ misma
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

- **Escaneos en paralelo** (fase ③): cada escaneo grande (1200 PPI, 16 bits)
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
