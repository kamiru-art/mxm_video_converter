"""Guías paso a paso de la app (los botones «?» de cada sección).

Cada guía es un dict con:
    titulo:  título de la ventana de ayuda
    intro:   párrafo corto de contexto ("para qué sirve esto")
    pasos:   lista de (emoji, título del paso, explicación detallada)

El objetivo es que Kamila pueda seguir cualquier parte del flujo sin leer el
manual completo: cada guía explica QUÉ es, PARA QUÉ sirve y CÓMO hacerlo, en
orden, con el detalle físico incluido (imprimir, exponer, escanear).
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
             "y volver después."),
            ("🖨️", "Fase ② · Generar hojas",
             "Eliges el video, cuántos fotogramas extraer y cómo repartirlos "
             "en hojas. Con los MARCADORES activados, cada hoja lleva ArUcos "
             "y QRs para que el escaneo se procese solo. En modo cianotipia "
             "las hojas salen como NEGATIVOS para acetato."),
            ("🎨", "El trabajo físico",
             "Imprimes, pintas sobre las hojas (o expones cianotipias con "
             "los negativos), y escaneas los resultados. La app tolera "
             "escaneos rotados, de cabeza, en espejo y con marcadores "
             "tapados."),
            ("📥", "Fase ③ · Procesar escaneos",
             "La app detecta los marcadores, endereza cada escaneo, lee los "
             "QRs y recorta cada fotograma alineado. Genera un informe con "
             "diagnóstico visual y hojas de rescate para lo que falte."),
            ("🎞️", "Fase ④ · Video final",
             "Reconstruye el video con tus fotogramas intervenidos, en el "
             "orden original del video."),
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
             "varios tamaños."),
            ("🖨️", "2 · Imprímela al 100 %",
             "MUY importante: en el diálogo de impresión desactiva «ajustar "
             "a página» / «encajar» — debe imprimirse al 100 % del tamaño "
             "real. Si la impresora la escala, la medición sale mal (la app "
             "lo detecta y te avisa, pero mejor evitarlo)."),
            ("🔍", "3 · Escanéala completa",
             "Escanea la página impresa entera (que no se corte ningún "
             "borde), a 300 DPI o más, y guarda el archivo. Si tu escáner "
             "no guarda el DPI en el archivo, anótalo: lo puedes escribir "
             "en la casilla «DPI del escaneo»."),
            ("🧮", "4 · Analiza el escaneo",
             "Elige el archivo escaneado y pulsa «Analizar escaneo». La app "
             "mide: la escala real de impresión (p. ej. 96.5 %), la "
             "respuesta tonal, y el tamaño mínimo de ArUco y QR que tu "
             "impresora reproduce de forma detectable."),
            ("💾", "5 · Guarda el perfil",
             "Ponle nombre (p. ej. «Epson de casa») y pulsa «Guardar "
             "perfil». Desde entonces, en la fase ② (pestaña Hoja) puedes "
             "elegir este perfil y la app compensará la escala y te "
             "recomendará tamaños seguros. Listo: no hay que repetirlo "
             "salvo que cambies de impresora."),
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
             "porque la curva debe medirse CON ese color."),
            ("📄", "1 · Genera la carta de curva",
             "Elige la carta («tira Kamiru» de 21 parches para empezar, o "
             "«EDN 2.2» de 256 tonos para máxima finura), el papel, el DPI, "
             "y el color de tinta (o tu perfil ColorBlocker). Deja el "
             "espejado activado si así imprimirás tus negativos. Pulsa "
             "«Generar carta de calibración…»."),
            ("🖨️", "2 · Imprime en ACETATO",
             "Imprime la carta al 100 % en una hoja de acetato/transparencia "
             "para inyección de tinta, en la calidad MÁS ALTA que tenga tu "
             "impresora (más tinta = mejor bloqueo). La carta sale en "
             "espejo: es correcto, se expone con la tinta contra el papel."),
            ("☀️", "3 · Expón, revela, lava y SECA",
             "Prepara papel emulsionado como siempre, pon el acetato en "
             "contacto (tinta contra emulsión — el triángulo de la esquina "
             "debe quedar legible apuntando a la derecha en la copia "
             "final), expón al sol tu tiempo habitual, revela, lava bien y "
             "deja SECAR del todo (el azul se oscurece al secar; medir "
             "húmedo falsea la curva)."),
            ("🔍", "4 · Escanea el RESULTADO AZUL",
             "Escanea la copia azul seca (NO el acetato), completa y plana. "
             "Cualquier resolución sirve; 300-600 DPI va perfecto."),
            ("🧮", "5 · Analiza y guarda",
             "Elige el escaneo, pulsa «Analizar» y revisa el rango dinámico "
             "medido (>60 % es bueno). Ponle nombre y guarda el perfil. En "
             "la fase ② → pestaña Cianotipia, elige esa curva: cada "
             "negativo saldrá compensado y tus copias tendrán los tonos "
             "completos y suaves, sin saltos."),
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
             "(bastan 3 visibles de 8)."),
            ("📁", "2 · Elige carpeta, layout y salida",
             "Carpeta con los escaneos, el layout .json de ESA tanda de "
             "hojas (se generó junto a ellas; cada tanda tiene el suyo) y "
             "una carpeta de salida para los fotogramas recuperados."),
            ("⚙️", "3 · Opciones",
             "«Automático» detecta el modo según el layout. El BLEED "
             "recorta un poco hacia dentro para evitar bordes de papel. "
             "Deja el resto por defecto salvo que sepas lo que buscas."),
            ("▶️", "4 · Procesa y revisa el INFORME",
             "Pulsa «Procesar escaneos». Al final, abre el informe HTML: "
             "muestra cada escaneo con su miniatura de alineación "
             "(marcadores verdes = detectados, rojos = perdidos, azul = "
             "recortes), el residuo de precisión en mm, y si llegó en "
             "espejo. Los fotogramas ilegibles quedan listados como "
             "faltantes."),
            ("🛟", "5 · ¿Faltó algo? Hojas de rescate",
             "Si el informe lista fotogramas faltantes (una hoja se dañó o "
             "un QR quedó ilegible), pulsa «Generar hojas de rescate»: se "
             "crean hojas SOLO con los que faltan, para reimprimir, "
             "intervenir y escanear de nuevo — sin repetir todo el "
             "proyecto."),
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
             "≥ 10 mm: la química se come los pequeños."),
            ("🏷️", "QR bajo cada fotograma",
             "Identifica el fotograma (proyecto, hoja, celda y nombre). Con "
             "UNO solo legible en la hoja ya se identifica la hoja entera. "
             "En cianotipia usa ≥ 12 mm."),
            ("📇", "El archivo layout .json",
             "Al generar las hojas se guarda un layout .json con la "
             "geometría exacta de todo. GUÁRDALO: es la llave para "
             "procesar los escaneos de esa tanda. Cada tanda de hojas "
             "tiene el suyo."),
            ("🎛️", "Tira de grises (opcional)",
             "Parches de gris de referencia para normalizar niveles del "
             "escáner al procesar (apagado por defecto: la filosofía es no "
             "tocar tu color)."),
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
             "con la polaridad normal."),
            ("◀️", "El triángulo testigo (junto al marcador superior)",
             "Chivato de orientación: en la copia azul correcta apunta a "
             "la DERECHA. Si en una copia apunta a la izquierda, esa hoja "
             "se expuso con el acetato al revés — no la tires: la app la "
             "procesa igual (voltea el escaneo sola), solo pierde un poco "
             "de nitidez."),
            ("⬛", "Borde bloqueador alrededor de cada frame",
             "Un marco fino (≈0.5-1 mm, configurable) de tinta a densidad "
             "MÁXIMA rodea cada fotograma. Evita que la luz se cuele por "
             "los cantos durante la exposición y vele los bordes de la "
             "imagen. Usa automáticamente tu color/degradado ColorBlocker "
             "si tienes perfil. Ponlo en 0 para desactivarlo."),
            ("💡", "Halos entintados (modo ahorro)",
             "En modo AHORRO el fondo va sin tinta (queda azul en la "
             "copia) y cada marcador/QR/nombre lleva su isla entintada "
             "(queda blanca) para ser legible. El halo de 5 mm aguanta "
             "manchas de brocha."),
            ("📈", "Curva de compensación",
             "Si elegiste un perfil de curva (fase ① Calibración), cada "
             "fotograma se corrige para que la química no aplaste los "
             "tonos. La app aplica además un difuminado fino (dithering) "
             "para que los degradados salgan continuos, sin escalones."),
        ],
    },
}
