"""Guías paso a paso de la app (los botones «?» de cada sección).

Cada guía es un dict con:
    titulo:  título de la ventana de ayuda
    intro:   párrafo corto de contexto ("para qué sirve esto")
    pasos:   lista de (emoji, título del paso, explicación, diagrama)

El cuarto elemento es el nombre de un diagrama de guide_art.py, que se dibuja
AL LADO del texto de ese paso. El objetivo es que cualquiera pueda seguir
cualquier parte del flujo sin leer el manual completo: cada paso dice QUÉ es,
PARA QUÉ sirve y CÓMO hacerlo, y el dibujo muestra el objeto físico del que se
está hablando (la hoja, el acetato, el sol, el escáner, la curva medida).

Los pasos admiten también la forma antigua de 3 elementos (sin diagrama).
"""

GUIDES = {
    # ────────────────────────────────────────────────────────────
    "flujo": {
        "titulo": "El flujo completo de Kamiru Studio",
        "intro": ("La app convierte un video en hojas imprimibles, te deja "
                  "intervenirlas físicamente (pintura o cianotipia) y luego "
                  "reconstruye el video con tus imágenes intervenidas. El "
                  "orden ideal es este:"),
        "pasos": [
            ("🎯", "Fase ① · Calibrar (una sola vez)",
             "Antes de gastar papel, tinta o sol: mide cómo imprime TU "
             "impresora y cómo responde TU proceso de cianotipia. Los "
             "perfiles que guardes aquí se aplican solos en el resto de la "
             "app. Si solo vas a pintar sobre papel (sin cianotipia), basta "
             "el perfil de impresora — e incluso puedes saltarte esta fase "
             "y volver después.",
             "flujo_calibrar"),
            ("🖨️", "Fase ② · Generar hojas",
             "Eliges el video, cuántos fotogramas extraer y cómo repartirlos "
             "en hojas. Con los MARCADORES activados, cada hoja lleva ArUcos "
             "y QRs para que el escaneo se procese solo. En modo cianotipia "
             "las hojas salen como NEGATIVOS para acetato.",
             "flujo_hojas"),
            ("🎨", "El trabajo físico",
             "Imprimes, pintas sobre las hojas (o expones cianotipias con "
             "los negativos), y escaneas los resultados. La app tolera "
             "escaneos rotados, de cabeza, en espejo y con marcadores "
             "tapados.",
             "flujo_fisico"),
            ("📥", "Fase ③ · Procesar escaneos",
             "La app detecta los marcadores, endereza cada escaneo, lee los "
             "QRs y recorta cada fotograma alineado. Genera un informe con "
             "diagnóstico visual y hojas de rescate para lo que falte.",
             "flujo_escanear"),
            ("🎞️", "Fase ④ · Video final",
             "Reconstruye el video con tus fotogramas intervenidos, en el "
             "orden original del video.",
             "flujo_video"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "calibracion_impresora": {
        "titulo": "Calibrar la impresora (paso a paso)",
        "intro": ("Las impresoras mienten: encogen la página un poco (2-4 %) "
                  "y aplastan los tonos. Este perfil mide la TUYA para que "
                  "las hojas impresas tengan las medidas exactas y para "
                  "saber qué tamaño mínimo de marcador/QR imprime bien. Se "
                  "hace UNA vez por impresora."),
        "pasos": [
            ("📄", "1 · Genera la página de prueba",
             "Elige papel y DPI (los mismos que usarás para tus hojas) y "
             "pulsa «Generar página de prueba…». Se guarda un archivo PNG o "
             "TIFF con marcadores, una rampa de tonos y marcadores/QRs de "
             "varios tamaños.",
             "imp_pagina"),
            ("🖨️", "2 · Imprímela al 100 %",
             "MUY importante: en el diálogo de impresión desactiva «ajustar "
             "a página» / «encajar» — debe imprimirse al 100 % del tamaño "
             "real. Si la impresora la escala, la medición sale mal (la app "
             "lo detecta y te avisa, pero mejor evitarlo).",
             "imp_imprimir"),
            ("🔍", "3 · Escanéala completa",
             "Escanea la página impresa entera (que no se corte ningún "
             "borde), a 300 DPI o más, y guarda el archivo. Si tu escáner "
             "no guarda el DPI en el archivo, anótalo: lo puedes escribir "
             "en la casilla «DPI del escaneo».",
             "imp_escanear"),
            ("🧮", "4 · Analiza el escaneo",
             "Elige el archivo escaneado y pulsa «Analizar escaneo». La app "
             "mide: la escala real de impresión (p. ej. 96.5 %), la "
             "respuesta tonal, y el tamaño mínimo de ArUco y QR que tu "
             "impresora reproduce de forma detectable.",
             "imp_analizar"),
            ("💾", "5 · Guarda el perfil",
             "Ponle nombre (p. ej. «Epson de casa») y pulsa «Guardar "
             "perfil». Desde entonces, en la fase ② (pestaña Hoja) puedes "
             "elegir este perfil y la app compensará la escala y te "
             "recomendará tamaños seguros. Listo: no hay que repetirlo "
             "salvo que cambies de impresora.",
             "imp_guardar"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "calibracion_cianotipia": {
        "titulo": "Calibrar el proceso de cianotipia (paso a paso)",
        "intro": ("La química de la cianotipia NO responde de forma lineal: "
                  "sin corrección, los medios tonos se aplastan y las "
                  "imágenes salen chatas. Esta calibración mide TU proceso "
                  "completo (impresora + acetato + emulsión + sol + lavado) "
                  "y construye la CURVA que lo compensa. Hazla una vez, y "
                  "repítela solo si cambias de tinta, acetato o química."),
        "pasos": [
            ("🎨", "0 · (Recomendado) Primero el ColorBlocker",
             "La tinta negra no siempre es la que mejor bloquea el UV. La "
             "carta ColorBlocker (elígela en «Carta») imprime cientos de "
             "colores en acetato; al exponerla y analizarla, la app "
             "descubre el color/degradado que MÁS bloquea en tu impresora "
             "y lo guarda como perfil de color. Hazlo antes que la curva, "
             "porque la curva debe medirse CON ese color.",
             "cya_colorblocker"),
            ("📄", "1 · Genera la carta de curva",
             "Elige la carta («tira Kamiru» de 21 parches para empezar, o "
             "«EDN 2.2» de 256 tonos para máxima finura), el papel, el DPI, "
             "y el color de tinta (o tu perfil ColorBlocker). Deja el "
             "espejado activado si así imprimirás tus negativos. Si tu "
             "impresora imprime mal los campos grandes de negro 100 %, "
             "activa «Color del fondo de la carta» y elige un color denso "
             "que sí imprima bien (el fondo no se mide, solo bloquea el "
             "UV). Pulsa «Generar carta de calibración…».",
             "cya_carta"),
            ("🖨️", "2 · Imprime en ACETATO",
             "Imprime la carta al 100 % en una hoja de acetato/transparencia "
             "para inyección de tinta, en la calidad MÁS ALTA que tenga tu "
             "impresora (más tinta = mejor bloqueo). La carta sale en "
             "espejo: es correcto, se expone con la tinta contra el papel.",
             "cya_acetato"),
            ("☀️", "3 · Expón y revela",
             "Prepara papel emulsionado como siempre, pon el acetato en "
             "contacto (tinta contra emulsión — el triángulo de la esquina "
             "debe quedar legible apuntando a la derecha en la copia "
             "final), expón al sol tu tiempo habitual, revela y lava bien.",
             "cya_exponer"),
            ("🌬️", "4 · Deja SECAR del todo",
             "El azul de Prusia se oscurece bastante al secar: medir la "
             "copia húmeda falsea la curva entera (mediría un rango "
             "dinámico que luego no existe). Espera a que la hoja esté "
             "completamente seca antes de escanear.",
             "cya_secar"),
            ("🔍", "5 · Escanea el RESULTADO AZUL",
             "Escanea la copia azul seca (NO el acetato), completa y plana. "
             "Cualquier resolución sirve; 300-600 DPI va perfecto.",
             "cya_escanear"),
            ("🧮", "6 · Analiza y guarda",
             "Elige el escaneo, pulsa «Analizar» y revisa el gráfico: la "
             "línea azul es lo que TU proceso hace de verdad y la verde es "
             "la curva que lo compensa. Un rango dinámico > 60 % es bueno. "
             "Ponle nombre y guarda el perfil. En la fase ② → pestaña "
             "Cianotipia, elige esa curva: cada negativo saldrá compensado "
             "y tus copias tendrán los tonos completos, sin saltos.",
             "cya_curva"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "escaneos": {
        "titulo": "Escanear y procesar las hojas (paso a paso)",
        "intro": ("Aquí la app convierte tus hojas pintadas (o tus copias "
                  "azules de cianotipia) de vuelta en fotogramas digitales "
                  "perfectamente alineados. Necesita dos cosas: los "
                  "escaneos y el archivo layout .json que se creó junto a "
                  "las hojas."),
        "pasos": [
            ("🔍", "1 · Escanea las hojas",
             "Escanea cada hoja completa (los 4 bordes visibles, sin "
             "recortar marcadores), a 300 DPI o más, y guarda todos los "
             "archivos en UNA carpeta. No importa si quedan rotados, de "
             "cabeza o incluso en espejo: la app los endereza sola. Los "
             "marcadores pueden estar parcialmente tapados de pintura "
             "(bastan 3 visibles de 8).",
             "esc_escanear"),
            ("📁", "2 · Elige carpeta, layout y salida",
             "Carpeta con los escaneos, el layout .json de ESA tanda de "
             "hojas (se generó junto a ellas; cada tanda tiene el suyo) y "
             "una carpeta de salida para los fotogramas recuperados.",
             "esc_archivos"),
            ("⚙️", "3 · Opciones",
             "«Automático» detecta el modo según el layout. El BLEED "
             "recorta un poco hacia dentro para evitar bordes de papel. "
             "Deja el resto por defecto salvo que sepas lo que buscas.",
             "esc_opciones"),
            ("▶️", "4 · Procesa y revisa el INFORME",
             "Pulsa «Procesar escaneos». Al final, abre el informe HTML: "
             "muestra cada escaneo con su miniatura de alineación "
             "(marcadores verdes = detectados, rojos = perdidos, azul = "
             "recortes), el residuo de precisión en mm, y si llegó en "
             "espejo. Los fotogramas ilegibles quedan listados como "
             "faltantes.",
             "esc_informe"),
            ("🛟", "5 · ¿Faltó algo? Hojas de rescate",
             "Si el informe lista fotogramas faltantes (una hoja se dañó o "
             "un QR quedó ilegible), pulsa «Generar hojas de rescate»: se "
             "crean hojas SOLO con los que faltan, para reimprimir, "
             "intervenir y escanear de nuevo — sin repetir todo el "
             "proyecto.",
             "esc_rescate"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "marcadores": {
        "titulo": "¿Qué son los marcadores y qué añaden a la hoja?",
        "intro": ("Los marcadores son lo que permite que el escaneo se "
                  "procese SOLO, sin Photoshop. Actívalos siempre que "
                  "planees escanear las hojas de vuelta. Esto es lo que "
                  "aparece en cada hoja:"),
        "pasos": [
            ("🔲", "Marcadores ArUco (los cuadraditos de las esquinas/bordes)",
             "Son anclas de posición: con ellos la app endereza el escaneo "
             "(rotación, perspectiva y escala) con precisión subpíxel. Se "
             "ponen 8-12 repartidos: puedes pintar encima de varios y la "
             "alineación sigue funcionando (bastan 3). En cianotipia usa "
             "≥ 10 mm: la química se come los pequeños.",
             "mk_aruco"),
            ("🏷️", "QR bajo cada fotograma",
             "Identifica el fotograma (proyecto, hoja, celda y nombre). Con "
             "UNO solo legible en la hoja ya se identifica la hoja entera. "
             "En cianotipia usa ≥ 12 mm.",
             "mk_qr"),
            ("📇", "El archivo layout .json",
             "Al generar las hojas se guarda un layout .json con la "
             "geometría exacta de todo. GUÁRDALO: es la llave para "
             "procesar los escaneos de esa tanda. Cada tanda de hojas "
             "tiene el suyo.",
             "mk_layout"),
            ("🎛️", "Tira de grises (opcional)",
             "Parches de gris de referencia para normalizar niveles del "
             "escáner al procesar (apagado por defecto: la filosofía es no "
             "tocar tu color).",
             "mk_grises"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "cianotipia": {
        "titulo": "El modo cianotipia: qué lleva cada negativo",
        "intro": ("Con el modo cianotipia, cada hoja sale como NEGATIVO "
                  "para imprimir en acetato y exponer al sol. Todo lo que "
                  "ves distinto en la hoja tiene un porqué físico:"),
        "pasos": [
            ("🔄", "Imágenes invertidas y hoja en espejo",
             "El negativo va invertido (las luces del original llevan "
             "tinta) y espejado, para exponer con la tinta CONTRA el papel "
             "(más nitidez). En la copia azul final todo queda derecho y "
             "con la polaridad normal.",
             "cy_invertido"),
            ("◀️", "El triángulo testigo (junto al marcador superior)",
             "Chivato de orientación: en la copia azul correcta apunta a "
             "la DERECHA. Si en una copia apunta a la izquierda, esa hoja "
             "se expuso con el acetato al revés — no la tires: la app la "
             "procesa igual (voltea el escaneo sola), solo pierde un poco "
             "de nitidez.",
             "cy_triangulo"),
            ("⬛", "Borde bloqueador alrededor de cada frame",
             "Un marco fino (≈0.5-1 mm, configurable) de tinta a densidad "
             "MÁXIMA rodea cada fotograma. Evita que la luz se cuele por "
             "los cantos durante la exposición y vele los bordes de la "
             "imagen. Usa automáticamente tu color/degradado ColorBlocker "
             "si tienes perfil. Ponlo en 0 para desactivarlo.",
             "cy_borde"),
            ("💡", "Halos entintados (modo ahorro)",
             "En modo AHORRO el fondo va sin tinta (queda azul en la "
             "copia) y cada marcador/QR/nombre lleva su isla entintada "
             "(queda blanca) para ser legible. El halo de 5 mm aguanta "
             "manchas de brocha.",
             "cy_halos"),
            ("🖤", "Color del bloqueador (si tu impresora odia el negro 100 %)",
             "Todo lo externo a los fotogramas (fondo completo, halos y "
             "borde bloqueador) se imprime por defecto con la tinta a "
             "densidad máxima — que con un degradado ColorBlocker es negro "
             "puro. Algunas impresoras imprimen mal los campos grandes de "
             "negro 100 % (bandas, tinta a rayas): activa «Color del "
             "bloqueador personalizado» y elige un color denso que tu "
             "impresora sí imprima bien. Solo tiene que bloquear el UV; "
             "no afecta a los tonos de las imágenes.",
             "cy_bloqueador"),
            ("📈", "Curva de compensación",
             "Si elegiste un perfil de curva (fase ① Calibración), cada "
             "fotograma se corrige para que la química no aplaste los "
             "tonos. La app aplica además un difuminado fino (dithering) "
             "para que los degradados salgan continuos, sin escalones.",
             "cy_curva"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "origen": {
        "titulo": "De dónde salen los fotogramas",
        "intro": ("Kamiru Studio parte de un video o de una carpeta de "
                  "imágenes que ya tengas. Todo lo demás (hojas, "
                  "escaneos, video final) se construye desde aquí."),
        "pasos": [
            ("🎬", "Un video o una carpeta",
             "Con un VIDEO la app extrae los fotogramas ella misma (y "
             "recuerda la posición de cada uno para reconstruir el video "
             "al final). Con una CARPETA usa las imágenes tal cual: sirve "
             "para dibujos escaneados, frames ya exportados o material "
             "mixto.",
             "src_video"),
            ("⏱️", "Rango a procesar (solo video)",
             "Puedes trabajar el video entero o solo un tramo, indicando "
             "inicio y fin en segundos. Es la forma rápida de probar una "
             "tanda corta antes de comprometer papel y tinta con el "
             "video completo.",
             "src_rango"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "fotogramas": {
        "titulo": "Cuántos fotogramas y cómo se reparten",
        "intro": ("Aquí decides cuánto trabajo físico vas a tener: cuántos "
                  "fotogramas salen del video y cuántos caben en cada "
                  "hoja. La estimación de abajo se actualiza sola."),
        "pasos": [
            ("⏱️", "Cuántos extraer",
             "Lo normal es muestrear N fotogramas por segundo (admite "
             "decimales: 0.5 = uno cada dos segundos). «Todos los "
             "fotogramas» es para mixed media cuadro a cuadro y genera "
             "MUCHAS hojas — mira siempre la estimación antes de generar.",
             "grid_fps"),
            ("▦", "Cuadrícula de la hoja",
             "Columnas × filas = imágenes por hoja. Menos imágenes por "
             "hoja = fotogramas más grandes para pintar. Para mixed media "
             "clásico, 2×2.",
             "grid_cuadricula"),
            ("✂️", "Incluir / excluir",
             "Por posición, p. ej. «1, 3-5». Sirve para saltarse "
             "fotogramas repetidos o rehacer solo una parte. Excluir "
             "manda sobre incluir.",
             "grid_seleccion"),
            ("♻️", "Dibujos repetidos (dedup)",
             "Si el video tiene fotogramas casi idénticos, la app imprime "
             "SOLO uno por grupo y lo reutiliza en todas sus posiciones al "
             "armar el video final: pintas una vez y ahorras papel, tinta "
             "y horas.",
             "grid_dedup"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "hoja": {
        "titulo": "La hoja: tamaño, calidad y perfil de impresora",
        "intro": ("Estos ajustes definen el objeto físico que vas a tener "
                  "en las manos. Si ya calibraste tu impresora, elige aquí "
                  "su perfil y las medidas impresas serán exactas."),
        "pasos": [
            ("📐", "Tamaño, orientación y márgenes",
             "El margen es el aire alrededor del contenido; con marcadores "
             "activados la app lo amplía sola si hace falta para que quepa "
             "la banda de ArUcos. «Mejor ajuste» prueba las dos "
             "orientaciones (y girar la cuadrícula) y elige la que hace "
             "los fotogramas más grandes.",
             "hoja_tamano"),
            ("🖨️", "Perfil de impresora",
             "Con un perfil activo, la app pre-agranda el contenido para "
             "compensar el encogimiento real de tu impresora, de modo que "
             "lo impreso mida lo que dice el layout (clave para que el "
             "escaneo recorte exactamente donde debe). Además puedes "
             "aplicar los tamaños de marcador/QR medidos como seguros.",
             "hoja_perfil"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "nombres": {
        "titulo": "Nombres de los fotogramas y número de hoja",
        "intro": ("Cada fotograma lleva un nombre y cada hoja un número: "
                  "son la referencia para organizarte sobre la mesa y, "
                  "sobre todo, lo que viaja dentro de los QR."),
        "pasos": [
            ("🏷️", "El nombre bajo cada fotograma",
             "Puede ser «nombre base + número» (abc_001, abc_002…) o el "
             "nombre del archivo de origen (útil con carpetas: conserva "
             "CLIP018, CLIP019…). Si el nombre no cabe impreso, la app "
             "achica la fuente y luego lo abrevia con «…», pero el nombre "
             "COMPLETO sigue dentro del QR y del layout: al procesar el "
             "escaneo se recupera íntegro.",
             "nombres"),
            ("#️⃣", "El número de hoja",
             "Va en la esquina que elijas. Con marcadores activados se "
             "corre hacia dentro para no invadir sus islas. Es lo que te "
             "permite apilar 40 hojas impresas y no perder el orden.",
             "pagenum"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "salida": {
        "titulo": "Qué archivos se generan",
        "intro": ("La app puede escribir varias cosas a la vez. Lo mínimo "
                  "para trabajar es un formato de hoja; el resto son "
                  "comodidades."),
        "pasos": [
            ("📄", "Formatos",
             "PNG por hoja (sin pérdida, el más práctico), PDF combinado "
             "(lo más cómodo para mandar a imprimir de una vez) y TIFF "
             "(sin pérdida, archivos grandes). Puedes marcar varios.",
             "salida"),
            ("🧩", "Qué hojas producir",
             "Por número de hoja, p. ej. «3, 5-7». Perfecto para "
             "reimprimir una hoja que se estropeó sin regenerar toda la "
             "tanda: el layout .json sigue describiéndolas todas, así que "
             "el procesado de escaneos no se entera.",
             "grid_seleccion"),
        ],
    },

    # ────────────────────────────────────────────────────────────
    "video_final": {
        "titulo": "Reconstruir el video final",
        "intro": ("El último paso: los fotogramas que recuperaste de los "
                  "escaneos vuelven a ser un video, en el orden original."),
        "pasos": [
            ("🎞️", "Layout + carpeta de fotogramas",
             "El layout .json guarda la línea de tiempo del video "
             "original, así que la app sabe en qué posición va cada "
             "fotograma — y repite automáticamente los que dedujiste como "
             "repetidos. Si falta alguno, se salta esa posición y te "
             "avisa.",
             "video_final"),
        ],
    },
}
