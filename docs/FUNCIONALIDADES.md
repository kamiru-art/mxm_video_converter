# MXM Studio — Análisis funcional completo

Este documento lista **todas** las funcionalidades de la aplicación y explica
cómo funciona cada una por dentro. Sirve como referencia de usuario avanzado y
como especificación del port a Rust/WebAssembly.

El flujo completo que cubre la app:

```
🎬 video (o carpeta de imágenes)
   → 🖨️ hojas de contacto imprimibles (con marcadores de registro)
      → ✋ pintar sobre el papel  /  ☀️ exponer cianotipias desde acetatos
         → 📠 escanear todo (en cualquier orden y orientación)
            → 🤖 la app endereza, identifica y recorta cada fotograma sola
               → 🎬 video final reconstruido
```

---

## Fase ① — Generar hojas de contacto

### 1.1 Origen de los fotogramas
- **Video**: se decodifica y se extraen fotogramas como PNG sin pérdida, sin
  ningún filtro de color (la única conversión es YUV→RGB del decodificador).
- **Carpeta de imágenes**: PNG/JPG/TIFF/WebP ya exportados o dibujados.
- **Rango**: inicio y fin en segundos, o el video completo.
- **Muestreo**: fps con decimales (`0.5` = un fotograma cada 2 s) o **TODOS**
  los fotogramas del rango (modo mixed media cuadro a cuadro).

### 1.2 Deduplicación perceptual (dibujos repetidos)
En animación es común sostener un dibujo varios cuadros. Detectarlo ahorra
papel, tinta y horas de pintura:
- Cada fotograma se reduce a 17×16 en escala de grises y se calcula un
  **dHash de 256 bits** (gradiente horizontal binarizado: bit = 1 si el píxel
  es más claro que su vecino derecho).
- Las imágenes con transparencia se aplanan sobre blanco antes del hash (lo
  que ve la impresión), no se descarta el alfa.
- Dos fotogramas son "el mismo dibujo" si su **distancia de Hamming ≤ 4**
  (tolera el ruido del códec). Se compara primero contra el último
  representante (los duplicados suelen ser consecutivos).
- Solo se imprime el **representante** de cada grupo; la **línea de tiempo**
  (`timeline` del layout.json) guarda la posición de cada duplicado para que
  el video final reutilice el dibujo pintado en todas sus apariciones.

### 1.3 Composición de la hoja
- **Tamaños de papel**: A3, A4, A5, A6, B4, B5, Carta, Oficio, Tabloide o
  personalizado (mm), a cualquier **DPI** (300 por defecto). Conversión
  mm→px: `round(mm / 25.4 × dpi)`.
- **Orientación**: vertical, horizontal o **mejor ajuste automático**: prueba
  las 4 combinaciones (vertical/horizontal × cuadrícula tal cual /
  columnas↔filas intercambiadas) y elige la que hace los fotogramas **más
  grandes** (compara el área resultante del primer fotograma).
- **Cuadrícula libre** (columnas × filas), espaciado entre celdas (gutter) y
  márgenes en mm. El margen se amplía automáticamente si no cabe la banda de
  marcadores.
- Los fotogramas se reescalan con **remuestreo Lanczos** conservando su
  relación de aspecto, centrados en su celda como bloque imagen+metadatos.
- **Transparencia (canal alfa)**: tres modos — fundir con el fondo de la hoja
  (sin gastar tinta), rellenar el rectángulo con un color, o dibujar solo un
  **borde** de color alrededor del fotograma.
- **Etiquetas**: nombre base + separador + número con ceros (`abc_001`), o el
  nombre del archivo original; numeración continua o la posición original en
  el video; fuente, tamaño (pt) y color configurables. Si una etiqueta no
  cabe, la fuente **se achica punto a punto hasta 6 pt** y después se **elide
  con `…`** — el QR y el layout.json conservan siempre el nombre completo.
  Las etiquetas repetidas se desambiguan con sufijos `_2`, `_3`… (dos
  etiquetas iguales harían irrecuperable el segundo fotograma).
- **Numerador de hoja** en cualquier esquina, con prefijo y ceros. Con
  marcadores activos se desplaza hacia dentro para no chocar con ellos.
- **Selección**: incluir/excluir fotogramas por posición (`1, 3-5`) y elegir
  qué hojas generar (`3, 5-7`) — reimprimir una hoja dañada sin regenerar
  todo. La geometría de TODAS las hojas se registra siempre en el layout.

### 1.4 Marcadores de registro (ArUco redundantes)
- Marcadores **ArUco DICT_4X4_50** (también 4X4_100 y 5X5_100) de tamaño y
  margen configurables en mm, con **zona de silencio** proporcional (lado/7;
  en cianotipia lado/4, porque la química mancha los bordes).
- **4, 8 o 12 marcadores** con IDs estables: 0–3 esquinas (TL,TR,BR,BL),
  4–7 centros de borde, 8–11 tercios de los bordes horizontales. Con 8
  marcadores bastan 3 sanos para alinear: se puede pintar encima del resto.
- **Un código QR por fotograma** (corrección de errores H, ~30 % de daño
  tolerado) con el formato compacto `K2|proyecto|hoja|celda|etiqueta`:
  **un solo QR legible identifica la hoja completa** aunque se escaneen
  desordenadas. (El prefijo `K2` se conserva por compatibilidad con los
  proyectos existentes.)
- **Tira de parches de grises** opcional (5 niveles: 0/64/128/192/255) en la
  banda izquierda, para normalizar niveles del escáner.

### 1.5 Modo CIANOTIPIA (negativos digitales)
Genera **negativos para acetato**: donde el acetato es transparente pasa el
UV y la copia queda azul; donde hay tinta queda blanco papel. Por eso
`densidad = brillo original`.
- **Curva de compensación** (LUT de 256 valores) medida con la calibración:
  lineariza la respuesta no lineal de la química. Ajustes:
  - **Fuerza** (0–100 %): mezcla lineal identidad ↔ curva calibrada.
  - **Adaptación al contenido** (0–100 %): redistribuye el rango tonal según
    el histograma de los fotogramas del proyecto (ecualización restringida:
    CDF suavizada con ventana 21, pendiente mínima del 15 %, monótona).
  - **Micro-contraste** (clarity 0–100 %): máscara de desenfoque de radio
    grande (min(lado)/24) aplicada al gris ANTES de la curva, para que el
    detalle sobreviva en las zonas que la curva comprime.
  - La cuantización a 8 bits se hace con **dithering** (ruido uniforme ±0.5,
    semilla fija = hojas reproducibles) para evitar bandas en degradados.
- **Color de tinta**: el negro no siempre bloquea mejor el UV. Se admite un
  color simple o un **degradado de 3+ paradas** `[(densidad, color), …]`
  (perfil ColorBlocker). Los marcadores/QRs/textos se colorean interpretando
  su gris como densidad invertida (celdas negras → transparente → azul).
- **Espejado** horizontal opcional (impresión emulsión-contra-emulsión).
- **Fondo**: **completo** (todo entintado → fondo blanco papel en la copia) o
  **AHORRO** (fondo transparente; solo marcadores/QRs/nombres llevan un
  **halo entintado** — 5 mm por defecto — para destacar sobre el azul).
  El halo reserva su espacio dentro de la celda: jamás tapa un fotograma.
- **Borde bloqueador** alrededor de cada fotograma (0.8 mm por defecto):
  marco a densidad máxima que evita que la luz se cuele por los cantos.
- **Color del bloqueador** configurable (impresoras que imprimen mal los
  campos grandes de negro 100 %).
- **Triángulo testigo de orientación** junto al marcador TL: en la copia
  correcta apunta a la derecha; si apunta a la izquierda, el acetato se
  expuso al revés (la app igualmente lo corrige al escanear).
- **Avisos de tamaños arriesgados**: marcadores <10 mm, QRs <12 mm, margen
  <6 mm o halos <4 mm sobreviven mal a la química; se avisa sin forzar nada.

### 1.6 Vista previa y simulación
- Vista previa navegable de todas las hojas a DPI reducido (proporcional).
- En cianotipia, **simulación de la copia azul final**: la densidad de cada
  píxel se deduce proyectando su color sobre el **eje de la tinta** (válido
  con tintas de color y degradados), y con la respuesta medida del perfil la
  simulación es un **soft-proof** por la curva real del proceso.

### 1.7 Salida
- **PNG** (con DPI en metadatos), **PDF combinado** (todas las hojas, listo
  para imprimir) y/o **TIFF**.
- **layout.json v2**: el mapa exacto de cada hoja — lienzo, bboxes de
  marcadores, frames y QRs por hoja, timeline, metadatos del video, snapshot
  completo de los ajustes (para hojas de rescate). Compatible en lectura con
  los layout v1 de la app antigua.
- Copia de los **fotogramas originales** junto al layout (para rescate) y
  exportación opcional de los fotogramas individuales.
- **Compensación de escala de impresora**: si el perfil dice que la impresora
  imprime al 97 %, el contenido se pre-escala 1/0.97 alrededor del centro; las
  coordenadas del layout describen los píxeles reales impresos.

---

## Fase ② — Procesar escaneos

Convierte los escaneos de las hojas pintadas/expuestas en fotogramas
digitales alineados, **sin Photoshop**.

1. **Lectura robusta**: TIFF/PNG/JPG/BMP/WebP, **8 o 16 bits** (los 16 bits
   se conservan de punta a punta), a cualquier resolución. Tope de 300 MP
   contra bombas de descompresión.
2. **Detección en proxy**: los marcadores se buscan primero en una versión
   reducida (lado ≤ 2400 px; si es débil, a la mitad — *binning* 2× que ahoga
   el grano químico). Se prueban **múltiples variantes de preprocesado** en
   orden de probabilidad: gris, canal rojo (el azul de Prusia es casi negro
   en ese canal → contraste máximo), CLAHE, **aplanado de fondo** (dividir
   por una versión muy desenfocada: neutraliza lavados desiguales),
   normalización — y cada una **también invertida** (hojas de modo normal
   expuestas como cianotipia salen en negativo). Si el modo normal encuentra
   pocos, se **escala automáticamente** a los parámetros relajados de
   cianotipia (umbral adaptativo más ancho, más bits erróneos tolerados…).
3. **Espejo automático**: los ArUco son quirales; si la copia se expuso con
   el acetato al revés, el escaneo llega en espejo. Se prueba la imagen
   espejada cuando la detección al derecho es débil, y gana la orientación
   con más marcadores. El volteo y el mapeo exacto proxy→resolución completa
   se resuelven en un solo lugar.
4. **Afinado subpíxel**: cada marcador se re-detecta en un recorte a
   resolución completa; si falla, se conservan las esquinas del proxy.
5. **Escala medida, no asumida**: mediana de los cocientes de distancias
   entre centros de marcadores (escaneo/layout). Cualquier DPI de escaneo
   funciona sin decirlo.
6. **Recuperación guiada**: con una homografía preliminar se proyecta dónde
   DEBERÍA estar cada marcador perdido y se re-busca localmente (ampliando
   3× los marcadores diminutos). Recupera marcadores lavados.
7. **Homografía RANSAC** con las 4 esquinas de TODOS los marcadores
   detectados (umbral proporcional a la diagonal). **Control de precisión**:
   se mide el residuo de reproyección por marcador; los inconsistentes
   (>2.5 mm o >3× la mediana) se descartan y se recalcula. El residuo mediano
   se publica en mm en el informe.
8. **Corrección local de recortes** (papel deformado): el papel de cianotipia
   se moja y ondula; una homografía global no lo sigue. El campo de residuos
   de los marcadores se interpola (ponderación por distancia inversa) y cada
   recorte se desplaza hacia donde el contenido quedó de verdad. Solo se
   activa si el residuo mediano supera 0.15 mm.
9. **Enderezado**: warp de perspectiva con interpolación **Lanczos4** al
   lienzo del layout × escala medida.
10. **Normalización opcional** con la tira de grises (corrección lineal por
    canal negro/blanco medidos → nominales; apagada por defecto).
11. **Identificación por QR**: se recorta cada zona de QR (ampliada un 35 %)
    y se decodifica probando variantes (gris/canal rojo, ampliación de QRs
    pequeños, Otsu, umbral adaptativo + cierre morfológico, polaridad
    invertida). El payload v2 dice proyecto+hoja: **un QR legible basta**, y
    un QR de OTRO proyecto se rechaza. Si el layout tiene una sola hoja se
    identifica por descarte (salvo que otro escaneo ya la haya reclamado por
    QR). Compatibilidad con QRs v1 (solo etiqueta).
12. **Recorte** de cada fotograma según su bbox × escala, con **bleed**
    configurable (1.5 % por defecto) y la corrección local aplicada.
    Opcionalmente se reescala cada recorte a su tamaño digital original.
13. **Modo emergencia**: marcadores OK pero ningún QR legible → los recortes
    se guardan en `sin_identificar/` para no perder el arte.
14. **Paralelismo**: varios escaneos a la vez.
15. **Informe**: JSON + CSV + HTML con miniaturas, estado por hoja
    (marcadores detectados, estrategia ganadora, escala, residuo en mm,
    espejado), fotogramas extraídos y **lista de faltantes**; miniatura de
    diagnóstico de la alineación (marcadores verdes/rojos, recortes azules,
    QRs naranjas).

---

## Fase ③ — Calibración

### 3.1 Perfil de impresora
Página de prueba con 8 marcadores, rampa tonal de 21 parches, marcadores de
4–12 mm (IDs 20–25) y QRs de 8–12 mm. Se imprime al 100 %, se escanea y la
app mide:
- **Escala real de impresión** (mediana de cocientes de distancias entre
  marcadores en mm nominales vs. escaneados, usando el DPI del escaneo) —
  avisa si supera ±3 % («ajustar a página» activado).
- **Respuesta tonal** (luminancia media de cada parche de la rampa).
- **Tamaño mínimo fiable** de ArUco y de QR: qué tamaños se detectan con el
  detector **estricto** (relajarlo inflaría la medición); recomendado =
  mínimo × 1.25 (marcador) / × 1.2 (QR).

### 3.2 Perfil de cianotipia (curva de compensación)
Dos cartas, ambas con el marco de 8 marcadores para análisis automático:
- **Tira de 21 parches** (rápida).
- **Carta EDN 2.2 de 256 tonos** (16×16, todos los valores 0–255), el método
  [Easy Digital Negatives](https://www.easydigitalnegatives.com/) de Peter
  Mrhar integrado.

Se imprime el negativo en acetato (con la MISMA tinta y espejado del
proyecto), se expone, revela, seca y escanea la copia azul. El análisis:
1. Alinea la carta con los marcadores (modo cianotipia, espejo automático).
2. Mide la luminancia media de cada parche (con encogimiento del 25–30 %).
3. **Diagnóstico previo**: respuesta **invertida** (se escaneó el acetato en
   vez de la copia) o **plana** (rango <10 %) → error explicado, no se
   construye una curva que arruinaría el proyecto.
4. Construye la curva sin escalones: promedio de duplicados → suavizado con
   ventana adaptativa (21→3, 256→17) → **regresión isotónica PAVA** (monótona
   sin mesetas) → **interpolación cúbica monótona PCHIP** sobre malla de
   2048 → pulido (media móvil 31 con reflexión impar) → **inversión
   numérica** → LUT flotante de 256 valores.
5. Informa el **rango dinámico** y sugiere mejoras si es <35 %.
6. La curva **recuerda con qué tinta se midió** para avisar si luego cambia.

### 3.3 EDN ColorBlocker (mejor color de tinta)
Carta de **36 matices × 21 variantes + columna de grises** (réplica del
ColorBlocker 3 de EDN, con marco de marcadores): se imprime en acetato, se
expone y se mide qué color **bloqueó mejor el UV** (el parche más claro de la
copia). Devuelve el mejor color, el matiz con mejor separación tonal (más
escalones ≥10, desempate por suavidad) y un **degradado de 3 paradas**
(sombras/medios/luces) aplicable a los negativos con un clic.

### 3.4 Gráficos y validaciones
Cada análisis dibuja sus resultados (respuesta medida vs. curva, color
ganador y degradado, escala y tamaños seguros) para juzgar de un vistazo si
la calibración salió sana.

---

## Fase ④ — Video final

- Resuelve la secuencia con la **línea de tiempo** del layout: cada posición
  usa el fotograma procesado de su **representante** (deduplicación), con
  índice de alias para etiquetas desambiguadas.
- Reporta los fotogramas faltantes antes de renderizar.
- Codifica a **MP4 H.264** (o variantes de máxima calidad) al fps original
  del proyecto, normalizando dimensiones a pares.

---

## Hojas de rescate

Tras procesar, el informe lista los fotogramas irrecuperables (QR pintado,
hoja perdida…). Un botón regenera hojas **solo con esos fotogramas**, usando
el snapshot de ajustes del layout original y las copias de los originales.
El prefijo de hoja gana una `R` y el resultado trae su propio layout: se
imprime, pinta, escanea y procesa igual; los recuperados caen con el resto.

---

## Presets y perfiles

- **Presets con nombre**: foto completa de todos los ajustes de la interfaz.
- **Perfiles de calibración** por tipo (impresora / curva de cianotipia /
  color de tinta), guardados como JSON reutilizable entre proyectos.

---

## Filosofía de calidad y color

- Extracción de fotogramas **sin pérdida** (PNG) y **sin filtros de color**.
- Composición a alta resolución con Lanczos; alineación con Lanczos4;
  **16 bits conservados de punta a punta**.
- En cianotipia sí se aplican (a propósito) inversión, curva y tinta: para
  eso están.
