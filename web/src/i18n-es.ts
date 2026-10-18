// Diccionario de la interfaz en español, para i18n.ts. La clave es el texto
// en inglés tal como llega al documento (con los espacios colapsados); en
// TEMPLATES, {0} es cualquier texto (que también se traduce) y {#0} un
// número. Generado de las traducciones por fase y revisado a mano.

export const EXACT: Record<string, string> = {
  // g1-shell
  'MXM Studio: mixed media & cyanotype animation, free forever':
    'MXM Studio: animación de técnica mixta y cianotipia, gratis para siempre',
  'Skip to the tools': 'Saltar a las herramientas',
  MXM: 'MXM',
  Studio: 'Studio',
  'mixed media & cyanotype animation, in your browser, free forever':
    'animación de técnica mixta y cianotipia, en tu navegador, gratis para siempre',
  Phases: 'Fases',
  Sheets: 'Hojas',
  'video → paper': 'video → papel',
  Scans: 'Escaneos',
  'paper → frames': 'papel → fotogramas',
  Video: 'Video',
  'frames → film': 'fotogramas → película',
  Calibration: 'Calibración',
  'your printer & your sun': 'tu impresora y tu sol',
  Help: 'Ayuda',
  'how it works': 'cómo funciona',
  'checking…': 'comprobando…',
  'Free forever. Nothing leaves your machine: everything runs in your browser (Rust → WebAssembly).':
    'Gratis para siempre. Nada sale de tu máquina: todo corre en tu navegador (Rust → WebAssembly).',
  'Source code': 'Código fuente',
  License: 'Licencia',
  'CC BY-NC-SA 4.0': 'CC BY-NC-SA 4.0',
  ': use it and change it, but never sell it. A changed version of the tool must keep the same license.':
    ': úsala y cámbiala, pero nunca la vendas. Una versión modificada de la herramienta debe mantener la misma licencia.',
  'Created by': 'Creado por',
  'Sebastian López': 'Sebastian López',
  WebGPU: 'WebGPU',
  'CPU (WebAssembly)': 'CPU (WebAssembly)',
  'This browser can straighten scans on the graphics card: the heavy step of phase ② runs several times faster and uses half the memory. TIFF and 16-bit PNG scans still go through WebAssembly, so their bit depth survives untouched.':
    'Este navegador puede enderezar los escaneos en la tarjeta gráfica: el paso pesado de la fase ② corre varias veces más rápido y usa la mitad de memoria. Los escaneos TIFF y PNG de 16 bits siguen pasando por WebAssembly, así su profundidad de bits queda intacta.',
  'No WebGPU here, so scans are straightened in WebAssembly on the processor. Everything works; heavy scans just take longer. Chrome or Edge on a recent machine enables the GPU path.':
    'Aquí no hay WebGPU, así que los escaneos se enderezan en WebAssembly en el procesador. Todo funciona; los escaneos pesados solo tardan más. Chrome o Edge en una máquina reciente activa la vía de GPU.',
  'Could not create a 2D canvas context.': 'No se pudo crear un contexto de lienzo 2D.',
  'Click to dismiss': 'Haz clic para cerrar',
  Cancel: 'Cancelar',
  'Cancelling…': 'Cancelando…',
  'That folder has no files this step can use.':
    'Esa carpeta no tiene archivos que este paso pueda usar.',
  'or choose a folder…': 'o elige una carpeta…',
  'Previous image': 'Imagen anterior',
  'Next image': 'Imagen siguiente',
  'Image preview': 'Vista previa de la imagen',
  'Preview of the final video': 'Vista previa del video final',
  Play: 'Reproducir',
  Frame: 'Fotograma',
  Pause: 'Pausar',
  'The preview could not be loaded.': 'La vista previa no se pudo cargar.',
  'Cancelled.': 'Cancelado.',
  'This browser is blocking storage for this site, so nothing was saved. Allow site data for this page (private windows and strict cookie settings turn it off); meanwhile “Export everything” in Calibration keeps your profiles in a file.':
    'Este navegador está bloqueando el almacenamiento de este sitio, así que no se guardó nada. Permite los datos del sitio para esta página (las ventanas privadas y los ajustes estrictos de cookies lo desactivan); mientras tanto, “Exportar todo” en Calibración guarda tus perfiles en un archivo.',
  'The browser storage for this site is full, so nothing was saved. Use “Export everything” in Calibration to keep a copy, then delete the presets or profiles you no longer need and try again.':
    'El almacenamiento del navegador para este sitio está lleno, así que no se guardó nada. Usa “Exportar todo” en Calibración para guardar una copia, luego borra los preajustes o perfiles que ya no necesites e inténtalo de nuevo.',
  'The file is not a profiles export (expected a JSON object).':
    'El archivo no es una exportación de perfiles (se esperaba un objeto JSON).',
  'The frame encoder returned no thumbnail.': 'El codificador de fotogramas no devolvió miniatura.',
  'The frame converter returned no pixels.': 'El conversor de fotogramas no devolvió píxeles.',
  'The video frame could not be decoded.': 'El fotograma del video no se pudo decodificar.',
  'The frame encoder returned no PNG.': 'El codificador de fotogramas no devolvió PNG.',
  cancelled: 'cancelado',
  'The export was cancelled.': 'La exportación se canceló.',
  'OPFS writer stopped': 'El escritor OPFS se detuvo',
  'OPFS writer stopped: unreadable reply': 'El escritor OPFS se detuvo: respuesta ilegible',
  'The browser ran out of room on disk for this project. Free space (or empty the site data of this browser) and try again.':
    'El navegador se quedó sin espacio en disco para este proyecto. Libera espacio (o vacía los datos del sitio de este navegador) e inténtalo de nuevo.',
  'The processing engine could not start. Reload the page: this usually happens when the site was updated while this tab was open.':
    'El motor de procesamiento no pudo arrancar. Recarga la página: esto suele pasar cuando el sitio se actualizó mientras esta pestaña estaba abierta.',
  'unknown error': 'error desconocido',
  'A result from the processing worker could not be read. Try again with a smaller image.':
    'Un resultado del worker de procesamiento no se pudo leer. Inténtalo de nuevo con una imagen más pequeña.',
  'The processing step stopped responding and was restarted. Try again; if it keeps happening, use a smaller scan or fewer sheets at a time.':
    'El paso de procesamiento dejó de responder y se reinició. Inténtalo de nuevo; si sigue pasando, usa un escaneo más pequeño o menos hojas a la vez.',
  'Could not create a 2D canvas context in the worker.':
    'No se pudo crear un contexto de lienzo 2D en el worker.',
  'pdf_add without pdf_new': 'pdf_add sin pdf_new',
  'pdf_finish without pdf_new': 'pdf_finish sin pdf_new',
  'The ZIP is already finished.': 'El ZIP ya está terminado.',
  'ZIP write without an open entry.': 'Escritura en el ZIP sin una entrada abierta.',
  'ZIP end without an open entry.': 'Cierre en el ZIP sin una entrada abierta.',
  'ZIP finished with an entry still open.': 'ZIP terminado con una entrada todavía abierta.',
  'Continue on this phone?': '¿Continuar en este teléfono?',
  Language: 'Idioma',
  // g2-phase1
  'Best fit (automatic)': 'Mejor ajuste (automático)',
  Portrait: 'Vertical',
  Landscape: 'Horizontal',
  'Bottom right': 'Abajo a la derecha',
  'Bottom left': 'Abajo a la izquierda',
  'Top right': 'Arriba a la derecha',
  'Top left': 'Arriba a la izquierda',
  Letter: 'Carta',
  Tabloid: 'Tabloide',
  Custom: 'Personalizado',
  'analyzing repeated drawings…': 'analizando dibujos repetidos…',
  'no repeated drawings in the selection.': 'no hay dibujos repetidos en la selección.',
  'No frames yet.': 'Aún no hay fotogramas.',
  end: 'fin',
  'ALL frames (frame by frame)': 'TODOS los fotogramas (fotograma a fotograma)',
  'Fast 8-bit decode (drops the extra bits of this video)':
    'Decodificación rápida de 8 bits (descarta los bits extra de este video)',
  'Extract frames': 'Extraer fotogramas',
  Stop: 'Detener',
  'Stopping…': 'Deteniendo…',
  'Stopped before the first frame.': 'Detenido antes del primer fotograma.',
  'They keep every bit of the video: 16 bits per channel.':
    'Conservan todos los bits del video: 16 bits por canal.',
  'Drop your video or a folder of images here': 'Suelta tu video o una carpeta de imágenes aquí',
  'MP4 / MOV / WebM / MKV / AVI / MPG / WMV, or PNG, JPG, TIFF, WebP (16-bit too). Nothing is uploaded.':
    'MP4 / MOV / WebM / MKV / AVI / MPG / WMV, o PNG, JPG, TIFF, WebP (también de 16 bits). No se sube nada.',
  'Reading the video…': 'Leyendo el video…',
  'None of those files could be read as an image.':
    'Ninguno de esos archivos se pudo leer como imagen.',
  'e.g. 1, 3-5 (empty = all)': 'p. ej. 1, 3-5 (vacío = todos)',
  'e.g. 8, 12': 'p. ej. 8, 12',
  'Auto-increment (abc_001…)': 'Autoincremento (abc_001…)',
  'Original file name': 'Nombre de archivo original',
  'Sequential (1, 2, 3…)': 'Secuencial (1, 2, 3…)',
  'Original (position in the video)': 'Original (posición en el video)',
  'Original (based on the frames)': 'Original (según los fotogramas)',
  'Detect repeated drawings (print each only once)':
    'Detectar dibujos repetidos (imprimir cada uno una sola vez)',
  'Your settings will not be remembered for the next session.':
    'Tus ajustes no se recordarán para la próxima sesión.',
  'Width (mm)': 'Ancho (mm)',
  'Height (mm)': 'Alto (mm)',
  'CYANOTYPE MODE: generate negatives for transparency film':
    'MODO CIANOTIPIA: generar negativos para película transparente',
  Cyanotype: 'Cianotipia',
  '(no curve: linear)': '(sin curva: lineal)',
  '(plain ink)': '(tinta plana)',
  'ColorBlocker gradient applied ().': 'Degradado de ColorBlocker aplicado ().',
  'Mirror (emulsion-to-emulsion printing)': 'Espejo (impresión emulsión contra emulsión)',
  'Ink color': 'Color de tinta',
  'Ink color profile (ColorBlocker)': 'Perfil de color de tinta (ColorBlocker)',
  'Compensation curve (cyanotype profile)': 'Curva de compensación (perfil de cianotipia)',
  'Measured in Calibration. Without a curve, density follows the original brightness.':
    'Medida en Calibración. Sin curva, la densidad sigue el brillo original.',
  'Curve strength (%)': 'Intensidad de la curva (%)',
  'How much of the calibrated curve to apply. 0 = none.':
    'Cuánto de la curva calibrada aplicar. 0 = nada.',
  'Micro-contrast (%)': 'Microcontraste (%)',
  'Local contrast. Brings out pencil lines.': 'Contraste local. Resalta las líneas de lápiz.',
  'Content adaptation (%)': 'Adaptación al contenido (%)',
  'Spends the ink range on the tones the drawings use instead of the whole scale. Useful when everything sits in the mid-greys. 0 prints the curve as calibrated.':
    'Dedica el rango de tinta a los tonos que usan los dibujos en vez de a toda la escala. Útil cuando todo está en los grises medios. 0 imprime la curva tal como se calibró.',
  'Negative background': 'Fondo del negativo',
  'INK-SAVING (inked halos only)': 'AHORRO DE TINTA (solo halos entintados)',
  'Full (entire background inked)': 'Completo (todo el fondo entintado)',
  'Inked halo (mm)': 'Halo entintado (mm)',
  'Blocking border (mm)': 'Borde de bloqueo (mm)',
  '(no compensation)': '(sin compensación)',
  '(choose a preset…)': '(elige un preajuste…)',
  'preset name': 'nombre del preajuste',
  'Saved presets': 'Preajustes guardados',
  Load: 'Cargar',
  Delete: 'Eliminar',
  'Save current settings as': 'Guardar los ajustes actuales como',
  Save: 'Guardar',
  'This browser keeps the ZIP in memory while it is made.':
    'Este navegador guarda el ZIP en memoria mientras se hace.',
  'That does not fit: generate fewer sheets at a time, or turn off TIFF or the frame files.':
    'Eso no cabe: genera menos hojas a la vez, o desactiva TIFF o los archivos de fotogramas.',
  'Generate sheets (ZIP)': 'Generar hojas (ZIP)',
  'There are no frames to print.': 'No hay fotogramas que imprimir.',
  'One sheet': 'Una hoja',
  'The ZIP was not produced.': 'No se produjo el ZIP.',
  'Generation cancelled. Nothing was written; the frames stay loaded.':
    'Generación cancelada. No se escribió nada; los fotogramas siguen cargados.',
  'Sheet preview': 'Vista previa de la hoja',
  'Simulate final blue print': 'Simular la copia azul final',
  landscape: 'horizontal',
  portrait: 'vertical',
  'Try it with a 6-frame example': 'Pruébalo con un ejemplo de 6 fotogramas',
  '4 (corners)': '4 (esquinas)',
  '8 (recommended)': '8 (recomendado)',
  '12 (maximum tolerance)': '12 (máxima tolerancia)',
  '① Generate contact sheets': '① Generar hojas de contactos',
  'From a video (or images) to printable sheets with registration markers.':
    'De un video (o imágenes) a hojas imprimibles con marcadores de registro.',
  'Start (s)': 'Inicio (s)',
  'End (s)': 'Fin (s)',
  'Selection & names': 'Selección y nombres',
  'Include frames': 'Incluir fotogramas',
  Exclude: 'Excluir',
  Labels: 'Etiquetas',
  'Base name': 'Nombre base',
  Separator: 'Separador',
  Digits: 'Dígitos',
  From: 'Desde',
  'Label numbering': 'Numeración de etiquetas',
  'Applies to auto-increment labels. Sequential counts the selected frames; Original uses each frame’s position in the whole video. A repeated drawing printed once keeps its number, so gaps are expected.':
    'Se aplica a las etiquetas de autoincremento. Secuencial cuenta los fotogramas seleccionados; Original usa la posición de cada fotograma en todo el video. Un dibujo repetido impreso una vez conserva su número, así que se esperan saltos.',
  'Sheet & grid': 'Hoja y cuadrícula',
  Paper: 'Papel',
  Orientation: 'Orientación',
  Columns: 'Columnas',
  Rows: 'Filas',
  'Margin (mm)': 'Margen (mm)',
  'Gutter (mm)': 'Separación (mm)',
  'Font (pt)': 'Fuente (pt)',
  'Sheet number': 'Número de hoja',
  Position: 'Posición',
  Prefix: 'Prefijo',
  'Sheet numbering': 'Numeración de hojas',
  'Both start at “From”. Sequential numbers the sheets in output order. Original uses the position of each sheet’s first frame in the whole project, so excluded frames do not renumber later sheets.':
    'Ambas empiezan en “Desde”. Secuencial numera las hojas en el orden de salida. Original usa la posición del primer fotograma de cada hoja en todo el proyecto, así que los fotogramas excluidos no renumeran las hojas siguientes.',
  'Registration (to scan back)': 'Registro (para volver a escanear)',
  'ArUco markers with per-sheet identity (required for phase ②)':
    'Marcadores ArUco con identidad por hoja (necesarios para la fase ②)',
  'Each sheet gets its own marker IDs: no QR codes needed, more room for the drawings.':
    'Cada hoja recibe sus propios IDs de marcadores: no hacen falta códigos QR, más espacio para los dibujos.',
  Markers: 'Marcadores',
  'Size (mm)': 'Tamaño (mm)',
  'Project name': 'Nombre del proyecto',
  '= output name': '= nombre de salida',
  'QR size (mm)': 'Tamaño del QR (mm)',
  'Add a QR code per frame (for projects with MANY sheets)':
    'Agregar un código QR por fotograma (para proyectos con MUCHAS hojas)',
  'Marker identity covers a limited number of sheets; the preview warns when a project exceeds it. QRs identify any number of sheets, at the cost of cell space.':
    'La identidad de los marcadores cubre un número limitado de hojas; la vista previa avisa cuando un proyecto lo supera. Los QR identifican cualquier número de hojas, a costa de espacio en la celda.',
  'Gray patch strip (scanner normalization)': 'Tira de parches grises (normalización del escáner)',
  Printer: 'Impresora',
  'Printer profile (Calibration tab)': 'Perfil de impresora (pestaña Calibración)',
  'Corrects the measured scale of your printer.': 'Corrige la escala medida de tu impresora.',
  Output: 'Salida',
  'Output name': 'Nombre de salida',
  'Sheets to generate': 'Hojas a generar',
  'e.g. 3, 5-7 (empty = all)': 'p. ej. 3, 5-7 (vacío = todas)',
  'Formats:': 'Formatos:',
  'PNG (one per sheet)': 'PNG (uno por hoja)',
  'PDF (print-ready)': 'PDF (listo para imprimir)',
  'layout.json, the map phase ② needs, is always included.':
    'layout.json, el mapa que necesita la fase ②, siempre se incluye.',
  'Include the frames as image files (phase ② needs them for rescue sheets; also handy on their own)':
    'Incluir los fotogramas como archivos de imagen (la fase ② los necesita para las hojas de rescate; también útiles por sí solos)',
  Presets: 'Preajustes',
  Preview: 'Vista previa',
  'Sheet generation cancelled.': 'Generación de hojas cancelada.',
  // g3-phase2
  'Load the layout.json produced by phase ①.': 'Carga el layout.json que produjo la fase ①.',
  'Use the current project layout': 'Usar el layout del proyecto actual',
  'You have not generated sheets in this session yet.': 'Aún no has generado hojas en esta sesión.',
  'Drop the layout.json here': 'Suelta el layout.json aquí',
  'Automatic (from the layout)': 'Automático (del layout)',
  Normal: 'Normal',
  'not detected': 'no detectada',
  'Resize each frame to its original digital size':
    'Redimensionar cada fotograma a su tamaño digital original',
  'Normalize levels with the gray strip (if the sheet has one)':
    'Normalizar niveles con la tira de grises (si la hoja tiene una)',
  'Local correction for warped paper (recommended for cyanotype)':
    'Corrección local para papel deformado (recomendada para cianotipia)',
  'Not reprocessed. The report stays as it was.': 'No se reprocesó. El informe queda como estaba.',
  'Drop your scans here (any order, any orientation)':
    'Suelta tus escaneos aquí (cualquier orden, cualquier orientación)',
  'TIFF / PNG / JPG / WebP, 8 or 16 bit, any resolution. Several at once.':
    'TIFF / PNG / JPG / WebP, 8 o 16 bits, cualquier resolución. Varios a la vez.',
  'A batch is already running. The new files were added to the loaded list; press Reprocess when it finishes.':
    'Ya hay un lote en marcha. Los archivos nuevos se agregaron a la lista cargada; pulsa Reprocesar cuando termine.',
  'Load the project layout.json first.': 'Carga primero el layout.json del proyecto.',
  'Wait for the current batch to finish.': 'Espera a que termine el lote actual.',
  'Not processed. The scans stay loaded for Reprocess.':
    'No se procesó. Los escaneos quedan cargados para Reprocesar.',
  'Processing finished. Check the report.': 'Procesamiento terminado. Revisa el informe.',
  'check the alignment overlay.': 'revisa la superposición de alineación.',
  Scan: 'Escaneo',
  Sheet: 'Hoja',
  Assign: 'Asignar',
  Alignment: 'Alineación',
  Frames: 'Fotogramas',
  Notes: 'Notas',
  automatic: 'automático',
  'Tell the app which sheet this scan is': 'Dile a la app qué hoja es este escaneo',
  'View the alignment overlay': 'Ver la superposición de alineación',
  alignment: 'alineación',
  'View at full size (← → to move between frames, Esc to close)':
    'Ver a tamaño completo (← → para moverte entre fotogramas, Esc para cerrar)',
  'by hand': 'a mano',
  mirrored: 'espejado',
  '— · mirrored': '— · espejado',
  'Look for the sheet number printed on the page': 'Busca el número de hoja impreso en la página',
  'This project printed no sheet number, so go by the drawings':
    'Este proyecto no imprimió número de hoja, así que guíate por los dibujos',
  'Read the sheet number this project printed on the top left of the page':
    'Lee el número de hoja que este proyecto imprimió arriba a la izquierda de la página',
  'Read the sheet number this project printed on the top right of the page':
    'Lee el número de hoja que este proyecto imprimió arriba a la derecha de la página',
  'Read the sheet number this project printed on the bottom left of the page':
    'Lee el número de hoja que este proyecto imprimió abajo a la izquierda de la página',
  'Read the sheet number this project printed on the bottom right of the page':
    'Lee el número de hoja que este proyecto imprimió abajo a la derecha de la página',
  'Two scans claim the same sheet:': 'Dos escaneos reclaman la misma hoja:',
  'Send the wrong one to another sheet with its selector, or set it back to automatic.':
    'Manda el equivocado a otra hoja con su selector, o vuelve a ponerlo en automático.',
  'Use “Rescue sheets” below to reprint only these.':
    'Usa “Hojas de rescate” abajo para reimprimir solo estos.',
  'No frames missing.': 'No falta ningún fotograma.',
  'Download frames + report (ZIP)': 'Descargar fotogramas + informe (ZIP)',
  'Clear results': 'Borrar resultados',
  'Drop the project frames folder (…_frames/)':
    'Suelta la carpeta de fotogramas del proyecto (…_frames/)',
  'The copies phase ① saved next to the layout, to reprint only the failed frames.':
    'Las copias que la fase ① guardó junto al layout, para reimprimir solo los fotogramas fallidos.',
  'This layout has no generation settings (is it from v1?). Generate the sheets with MXM Studio to use rescue.':
    'Este layout no tiene ajustes de generación (¿es de v1?). Genera las hojas con MXM Studio para usar el rescate.',
  'No original copy found for any missing frame.':
    'No se encontró copia original para ningún fotograma faltante.',
  'One rescue sheet': 'Una hoja de rescate',
  'Rescue sheets cancelled.': 'Hojas de rescate canceladas.',
  'Generate rescue sheets': 'Generar hojas de rescate',
  'Rescue sheets': 'Hojas de rescate',
  'No scans yet? Simulate them from this session’s sheets':
    '¿Aún no hay escaneos? Simúlalos con las hojas de esta sesión',
  'Generate the sheets in phase ① first.': 'Genera primero las hojas en la fase ①.',
  '② Process scans': '② Procesar escaneos',
  'Straightens each sheet with its markers, identifies it by marker IDs and crops every frame. A sheet nothing identifies can be assigned by hand in the report.':
    'Endereza cada hoja con sus marcadores, la identifica por los IDs de los marcadores y recorta cada fotograma. Una hoja que nada identifica se puede asignar a mano en el informe.',
  Options: 'Opciones',
  'Bleed (% per side)': 'Sangrado (% por lado)',
  'Perimeter crop to avoid paper edges.': 'Recorte perimetral para evitar los bordes del papel.',
  'Minimum markers': 'Mínimo de marcadores',
  'Detection mode': 'Modo de detección',
  'Machine RAM (GB)': 'RAM de la máquina (GB)',
  'Browsers report at most 8 GB. The real value lets more scans run in parallel.':
    'Los navegadores informan 8 GB como máximo. El valor real deja correr más escaneos en paralelo.',
  'Processing report': 'Informe de procesamiento',
  // g4-phase34
  'profile name': 'nombre del perfil',
  'Analyze first and give the profile a name.': 'Analiza primero y ponle un nombre al perfil.',
  'Save profile': 'Guardar perfil',
  'Save as': 'Guardar como',
  'red: measured response · blue: compensation curve':
    'rojo: respuesta medida · azul: curva de compensación',
  'Printer profile': 'Perfil de impresora',
  'Measures the real print scale, the tonal response and the smallest marker and QR your printer still prints legibly. Print at 100 %, scan the whole page and drop it here. Phase ① uses this profile to correct the scale.':
    'Mide la escala real de impresión, la respuesta tonal y el marcador y el QR más pequeños que tu impresora aún imprime legibles. Imprime al 100 %, escanea la página entera y suéltala aquí. La fase ① usa este perfil para corregir la escala.',
  DPI: 'DPI',
  'Scan DPI': 'DPI del escaneo',
  'The DPI you scanned at.': 'Los DPI a los que escaneaste.',
  'Print the page at 100 % (no “fit to page”), scan it whole and drop it here.':
    'Imprime la página al 100 % (sin “ajustar a la página”), escanéala entera y suéltala aquí.',
  'Download test page': 'Descargar página de prueba',
  'Drop the SCAN of the printed page': 'Suelta el ESCANEO de la página impresa',
  'Mirrored (like your real negatives)': 'En espejo (como tus negativos reales)',
  'Cyanotype curve': 'Curva de cianotipia',
  'Measures the response of your process (printer, film, chemistry, light) and builds the compensation curve with the 256-tone chart of Easy Digital Negatives 2.2. Expose the chart exactly as you expose your work.':
    'Mide la respuesta de tu proceso (impresora, película, química, luz) y crea la curva de compensación con la carta de 256 tonos de Easy Digital Negatives 2.2. Expón la carta exactamente como expones tu obra.',
  'Curve already on the chart': 'Curva ya aplicada a la carta',
  '(none: first pass)': '(ninguna: primera pasada)',
  'Second pass: pick the curve you saved from the first chart. The chart prints with it, and the new analysis corrects what it left. Save the result and use it instead of the first curve.':
    'Segunda pasada: elige la curva que guardaste de la primera carta. La carta se imprime con ella, y el nuevo análisis corrige lo que esa curva dejó. Guarda el resultado y úsalo en lugar de la primera curva.',
  'Negative ink': 'Tinta del negativo',
  'Print on transparency film at 100 %, in colour mode (not grayscale), expose your cyanotype as usual, develop, dry and scan the BLUE PRINT (not the film).':
    'Imprime en película transparente al 100 %, en modo color (no en escala de grises), expón tu cianotipo como siempre, revela, seca y escanea la COPIA AZUL (no la película).',
  'Download chart (negative for film)': 'Descargar carta (negativo para película)',
  'Drop the SCAN of the blue print': 'Suelta el ESCANEO de la copia azul',
  'Advanced options': 'Opciones avanzadas',
  'Several prints: drop the scans of several prints of the same chart together and the app averages them. It helps when a print came out uneven.':
    'Varias copias: suelta juntos los escaneos de varias copias de la misma carta y la app las promedia. Ayuda cuando una copia salió despareja.',
  'The last chart you downloaded used a different “Curve already on the chart”. Pick the one it was printed with, or the curve will be wrong.':
    'La última carta que descargaste usaba otra “Curva ya aplicada a la carta”. Elige aquella con la que se imprimió, o la curva saldrá mal.',
  'Second pass: this curve already includes the first one. Save it and use it instead.':
    'Segunda pasada: esta curva ya incluye la primera. Guárdala y úsala en su lugar.',
  'Drop at least one scan of the chart.': 'Suelta al menos un escaneo de la carta.',
  'The curve applied to the chart has invalid values.':
    'La curva aplicada a la carta tiene valores no válidos.',
  'The curve applied to the chart is not increasing.':
    'La curva aplicada a la carta no es creciente.',
  "No hue followed the chart's nominal order, so all of them were considered. Check that the scan is flat and evenly lit, and that the print was not over- or underexposed.":
    'Ningún matiz siguió el orden nominal de la carta, así que se consideraron todos. Comprueba que el escaneo esté plano y con luz pareja, y que la copia no esté sobreexpuesta ni subexpuesta.',
  Mirrored: 'En espejo',
  'EDN ColorBlocker': 'EDN ColorBlocker',
  '36 hues × 21 variants: finds the ink color that blocks UV best on your printer (not always black) and builds a 3-stop gradient. Print at maximum quality: a draft setting ruins this chart.':
    '36 matices × 21 variantes: encuentra el color de tinta que mejor bloquea el UV en tu impresora (no siempre el negro) y crea un degradado de 3 paradas. Imprime a máxima calidad: un ajuste de borrador arruina esta carta.',
  'Print on transparency film at 100 % at MAXIMUM quality, expose, develop, dry and scan the blue print.':
    'Imprime en película transparente al 100 % a calidad MÁXIMA, expón, revela, seca y escanea la copia azul.',
  'Download ColorBlocker chart': 'Descargar carta ColorBlocker',
  'Best UV blocker:': 'Mejor bloqueador de UV:',
  'Gradient (shadows → highlights):': 'Degradado (sombras → luces):',
  'Your profiles & presets': 'Tus perfiles y preajustes',
  'Stored in this browser only: clearing site data deletes them. Export a JSON to move them to another machine or to keep a copy with the project.':
    'Guardados solo en este navegador: borrar los datos del sitio los elimina. Exporta un JSON para llevarlos a otra máquina o para guardar una copia con el proyecto.',
  'Save a copy': 'Guardar una copia',
  'Export everything': 'Exportar todo',
  'Bring some back': 'Recuperar algunos',
  'Import profiles (JSON)': 'Importar perfiles (JSON)',
  'Profiles imported.': 'Perfiles importados.',
  'Lossless MOV (Resolve, Premiere, After Effects, VLC)':
    'MOV sin pérdida (Resolve, Premiere, After Effects, VLC)',
  'Lossless PNG frames in a ZIP (any editor, Final Cut)':
    'Fotogramas PNG sin pérdida en un ZIP (cualquier editor, Final Cut)',
  'MP4, compressed (plays anywhere, much smaller)':
    'MP4, comprimido (se reproduce en cualquier parte, mucho más pequeño)',
  'Best (largest file)': 'Máxima (archivo más grande)',
  High: 'Alta',
  'Compact (to send)': 'Compacta (para enviar)',
  'Fixed bitrate': 'Bitrate fijo',
  Quality: 'Calidad',
  'Bitrate (Mbps)': 'Bitrate (Mbps)',
  'Project name…': 'Nombre del proyecto…',
  'Add the sound of the original video, in sync with the frames':
    'Agregar el sonido del video original, sincronizado con los fotogramas',
  'Original video (for its audio)': 'Video original (para su audio)',
  'Optional: the clip the frames came from, or an edited sound file. Only its sound is used.':
    'Opcional: el clip del que salieron los fotogramas, o un archivo de sonido editado. Solo se usa su sonido.',
  'Skip the missing frames': 'Saltar los fotogramas que faltan',
  'Cut their sound too': 'Cortar también su sonido',
  'Each missing frame shows the drawing before it, so the video lasts as long as the original range and stays in sync with its sound.':
    'Cada fotograma que falta muestra el dibujo anterior, así que el video dura lo mismo que el tramo original y sigue sincronizado con su sonido.',
  'The missing frames and their sound are left out. Each drawing keeps its own sound, and the rest joins with no silent gaps.':
    'Se quitan los fotogramas que faltan y su sonido. Cada dibujo conserva su propio sonido, y el resto se une sin silencios.',
  'The missing frames are left out, and the sound plays without cuts. Use this when the sound was already edited without those frames.':
    'Se quitan los fotogramas que faltan, y el sonido suena sin cortes. Úsalo cuando el sonido ya está editado sin esos fotogramas.',
  'No original video at hand: drop it above to add its sound. The video comes out silent otherwise.':
    'No hay video original a mano: suéltalo arriba para agregar su sonido. De lo contrario, el video sale mudo.',
  '16 bits per channel': '16 bits por canal',
  '8 bits per channel': '8 bits por canal',
  '16 bits per channel with transparency': '16 bits por canal con transparencia',
  '8 bits per channel with transparency': '8 bits por canal con transparencia',
  'every drawing is copied as it is': 'cada dibujo se copia tal cual',
  'Reading the frames…': 'Leyendo los fotogramas…',
  project: 'proyecto',
  'Load a layout.json (or process scans in phase ②).':
    'Carga un layout.json (o procesa escaneos en la fase ②).',
  'Save the video': 'Guardar el video',
  'No layout.': 'No hay layout.',
  'There are no frames to build the video.': 'No hay fotogramas para crear el video.',
  'Video export cancelled.': 'Exportación de video cancelada.',
  'There are no frames to preview.': 'No hay fotogramas para la vista previa.',
  '③ Final video': '③ Video final',
  'Rebuilds the video from the processed frames in their original order, reusing deduplicated drawings wherever they appear. The lossless files keep every pixel at full depth; the MP4 is a light copy to watch and share.':
    'Reconstruye el video desde los fotogramas procesados en su orden original, reusando los dibujos deduplicados dondequiera que aparezcan. Los archivos sin pérdida conservan cada píxel a profundidad completa; el MP4 es una copia ligera para ver y compartir.',
  'Project layout.json (optional if you come from phase ②)':
    'layout.json del proyecto (opcional si vienes de la fase ②)',
  'Add processed frames from files (optional)':
    'Agrega fotogramas procesados desde archivos (opcional)',
  'Frames processed in another session (PNG or TIFF, 8 or 16 bit): drop the folder here.':
    'Fotogramas procesados en otra sesión (PNG o TIFF, 8 o 16 bits): suelta la carpeta aquí.',
  'Frames per second': 'Fotogramas por segundo',
  'From the project; editable.': 'Del proyecto; editable.',
  Sound: 'Sonido',
  'Audio starts at (s)': 'El audio empieza en (s)',
  'Where the extracted range began in the original; filled in from the layout.':
    'Donde empezaba el rango extraído en el original; se rellena desde el layout.',
  'File name': 'Nombre del archivo',
  'Browsers and phones cannot play the lossless files: watch the sequence here, with its sound.':
    'Los navegadores y los teléfonos no pueden reproducir los archivos sin pérdida: mira la secuencia aquí, con su sonido.',
  // g5-media
  'The frames per second must be a number greater than zero.':
    'Los fotogramas por segundo deben ser un número mayor que cero.',
  'Opening the original': 'La apertura del original',
  'The original': 'El original',
  'The sound decoder': 'El decodificador de sonido',
  'this browser cannot hold a bitrate fixed, so it keeps it as the average':
    'este navegador no puede mantener fijo el bitrate, así que lo toma como promedio',
  'Best quality': 'Calidad máxima',
  'High quality': 'Calidad alta',
  Compact: 'Compacta',
  'The bitrate follows the picture: still drawings take little, busy ones more.':
    'El bitrate sigue a la imagen: los dibujos quietos ocupan poco, los cargados más.',
  'It loses detail on purpose; keep the lossless MOV or PNG frames as the master.':
    'Pierde detalle a propósito; conserva el MOV o los fotogramas PNG sin pérdida como máster.',
  'The sound encoder failed.': 'El codificador de sonido falló.',
  'The video encoder produced no output.': 'El codificador de video no produjo salida.',
  'The file has no video track (or the format is not supported).':
    'El archivo no tiene pista de video (o el formato no es compatible).',
  'not a number': 'no es un número',
  'an unknown type': 'un tipo desconocido',
  'The video converter manifest lists no parts; rebuild web/public/ffmpeg/ with "npm run build".':
    'El manifiesto del conversor de video no lista partes; reconstruye web/public/ffmpeg/ con "npm run build".',
  'The file could not be decoded (unsupported or damaged video).':
    'No se pudo decodificar el archivo (video no compatible o dañado).',
  'The video decoder returned text instead of image bytes.':
    'El decodificador de video devolvió texto en vez de bytes de imagen.',
  // g6-rust
  'Frame dimensions overflow': 'Desbordamiento en las dimensiones del fotograma',
  'Frame offset overflows': 'El desplazamiento del fotograma se desborda',
  'Pixel buffer shorter than the metadata': 'Búfer de píxeles más corto que los metadatos',
  'Frame without pixels': 'Fotograma sin píxeles',
  'Image dimensions overflow': 'Desbordamiento en las dimensiones de la imagen',
  'RGBA buffer does not match the given dimensions':
    'El búfer RGBA no coincide con las dimensiones dadas',
  'state without scale': 'estado sin escala',
  'PDF already finalized': 'PDF ya finalizado',
  'Could not estimate the scan scale.': 'No se pudo estimar la escala del escaneo.',
  'Could not align the scan (degenerate homography).':
    'No se pudo alinear el escaneo (homografía degenerada).',
  'The printer scales by more than 3 %: the driver probably has "fit to page" enabled. Disable it and print at 100 %.':
    'La impresora escala más de un 3 %: probablemente el controlador tiene activado "ajustar a la página". Desactívalo e imprime al 100 %.',
  'Not enough distances could be measured for the scale.':
    'No se pudieron medir suficientes distancias para la escala.',
  'Scan DPI not provided: print scale could not be measured (only tonal response and minimum sizes).':
    'No se indicaron los DPI del escaneo: no se pudo medir la escala de impresión (solo la respuesta tonal y los tamaños mínimos).',
  'The tonal ramp has little contrast in the scan; check the scanner exposure.':
    'La rampa tonal tiene poco contraste en el escaneo; revisa la exposición del escáner.',
  'No marker in the size test was detected: use 10-12 mm markers and check print quality.':
    'No se detectó ningún marcador en la prueba de tamaños: usa marcadores de 10-12 mm y revisa la calidad de impresión.',
  'No QR in the test could be read: use QRs of 12 mm or larger.':
    'No se pudo leer ningún QR de la prueba: usa QR de 12 mm o más.',
  'Not enough patches could be measured; check that the scan is complete, flat and well lit.':
    'No se pudieron medir suficientes parches; comprueba que el escaneo esté completo, plano y bien iluminado.',
  'The measured response is INVERTED: patches with more ink came out darker. Usually this means you scanned the FILM instead of the blue print; scan the dried cyanotype and analyze again.':
    'La respuesta medida está INVERTIDA: los parches con más tinta salieron más oscuros. Normalmente significa que escaneaste la PELÍCULA en vez de la copia azul; escanea el cianotipo seco y analiza de nuevo.',
  'Low dynamic range (<35 %). Suggestions: increase exposure, verify that full ink on the film actually blocks light (or use the ColorBlocker) and check the wash.':
    'Rango dinámico bajo (<35 %). Sugerencias: aumenta la exposición, verifica que la tinta plena en la película de verdad bloquee la luz (o usa el ColorBlocker) y revisa el lavado.',
  'Excellent dynamic range. 💙': 'Rango dinámico excelente. 💙',
  'Not enough ColorBlocker patches could be measured; check the scan.':
    'No se pudieron medir suficientes parches del ColorBlocker; revisa el escaneo.',
  'The chart has almost no contrast: the exposure was far too short or too long.':
    'La carta casi no tiene contraste: la exposición fue demasiado corta o demasiado larga.',
  'On your printer black/gray is the best blocker: you can keep using black ink.':
    'En tu impresora el negro/gris es el mejor bloqueador: puedes seguir usando tinta negra.',
  'The layout is invalid or incomplete (no markers).':
    'El layout no es válido o está incompleto (sin marcadores).',
  'The scan arrived MIRRORED (film exposed flipped?); it was flipped back automatically before processing.':
    'El escaneo llegó ESPEJADO (¿película expuesta volteada?); se volteó automáticamente antes de procesarlo.',
  'Mirrored scan (unexpected: the negative was generated without mirroring); flipped back automatically.':
    'Escaneo espejado (inesperado: el negativo se generó sin espejar); volteado automáticamente.',
  'Markers with INVERTED POLARITY (normal-mode sheet exposed as cyanotype?); they were detected in negative.':
    'Marcadores con POLARIDAD INVERTIDA (¿hoja en modo normal expuesta como cianotipia?); se detectaron en negativo.',
  'No detected marker exists in the layout.': 'Ningún marcador detectado existe en el layout.',
  'The detected markers cover little of the sheet; alignment may lose precision near the far edges.':
    'Los marcadores detectados cubren poco de la hoja; la alineación puede perder precisión cerca de los bordes lejanos.',
  'Could not compute the homography (degenerate markers).':
    'No se pudo calcular la homografía (marcadores degenerados).',
  'Levels normalized with the patch strip.': 'Niveles normalizados con la tira de parches.',
  'No marker identity or readable QR: sheet identified by elimination (the layout has a single sheet). Verify in the report that this scan belongs to this project.':
    'Sin identidad de marcadores ni QR legible: hoja identificada por eliminación (el layout tiene una sola hoja). Verifica en el informe que este escaneo pertenece a este proyecto.',
  "Sheet not identified: crops saved as 'unidentified'.":
    "Hoja no identificada: recortes guardados como 'sin identificar'.",
  'The sheet could not be identified (no marker identity or readable QR).':
    'No se pudo identificar la hoja (sin identidad de marcadores ni QR legible).',
  'The sheet needs at least one column and one row.':
    'La hoja necesita al menos una columna y una fila.',
  'The margins are too large for the sheet size.':
    'Los márgenes son demasiado grandes para el tamaño de la hoja.',
  'Not enough room for the cells. Reduce columns/rows, margins, gutter or halo, or increase the sheet size/DPI.':
    'No hay espacio suficiente para las celdas. Reduce columnas/filas, márgenes, separación o halo, o aumenta el tamaño/DPI de la hoja.',
  'Empty video frame.': 'Fotograma de video vacío.',
  'Video frame too large.': 'Fotograma de video demasiado grande.',
  'RGB48LE needs one plane.': 'RGB48LE necesita un plano.',
  // extra
  Legal: 'Oficio',
  'con mucho cariño, para': 'con mucho cariño, para',
  cyanotype: 'cianotipia',
  normal: 'normal',
  cianotipia: 'cianotipia',
};

export const TEMPLATES: [string, string][] = [
  // g1-shell
  ['WebGPU · {#0} cores', 'WebGPU · {#0} núcleos'],
  ['CPU (WebAssembly) · {#0} cores', 'CPU (WebAssembly) · {#0} núcleos'],
  ['Could not load the WebAssembly core: {0}', 'No se pudo cargar el núcleo WebAssembly: {0}'],
  ['{0} elapsed · ~{1} left', '{0} transcurrido · ~{1} restante'],
  ['{0} elapsed', '{0} transcurrido'],
  ['~{0} left', '~{0} restante'],
  ['Could not read that folder: {0}', 'No se pudo leer esa carpeta: {0}'],
  ['Loading the preview… {#0} / {#1}', 'Cargando la vista previa… {#0} / {#1}'],
  [
    'MXM Studio moved here from {0}, but your saved presets and profiles could not be copied over ({1}). They are still there: open {2}/?export to download them, then load the file with Import profiles in Calibration.',
    'MXM Studio se mudó aquí desde {0}, pero tus preajustes y perfiles guardados no se pudieron copiar ({1}). Siguen allí: abre {2}/?export para descargarlos, luego carga el archivo con Importar perfiles en Calibración.',
  ],
  ['Frame {0} has no image.', 'El fotograma {0} no tiene imagen.'],
  ['OPFS writer stopped: {0}', 'El escritor OPFS se detuvo: {0}'],
  ['Processing worker failed: {0}', 'El worker de procesamiento falló: {0}'],
  [
    'Could not send the “{0}” command to the processing worker: {1}',
    'No se pudo enviar el comando “{0}” al worker de procesamiento: {1}',
  ],
  [
    'The WebAssembly core could not load ({0}). Reload the page: this usually happens when the site was updated while this tab was open.',
    'El núcleo WebAssembly no se pudo cargar ({0}). Recarga la página: esto suele pasar cuando el sitio se actualizó mientras esta pestaña estaba abierta.',
  ],
  [
    'The video decoder returned {#0} bytes for a {#1}×{#2} frame ({#3} expected).',
    'El decodificador de video devolvió {#0} bytes para un fotograma de {#1}×{#2} ({#3} esperados).',
  ],
  ['Unknown command: {0}', 'Comando desconocido: {0}'],
  [
    '"{0}" can no longer be read ({1}): its file is gone. The site data was cleared, the browser freed disk space, or the source file was moved: load or process the project again.',
    '"{0}" ya no se puede leer ({1}): su archivo ya no está. Se borraron los datos del sitio, el navegador liberó espacio en disco, o el archivo de origen se movió: carga o procesa el proyecto de nuevo.',
  ],
  [
    'Could not read "{0}" while packing the ZIP ({1}). The browser ran out of room for the files of this project: generate fewer sheets at a time, turn off TIFF or the frame files, or free disk space.',
    'No se pudo leer "{0}" al empaquetar el ZIP ({1}). El navegador se quedó sin espacio para los archivos de este proyecto: genera menos hojas a la vez, desactiva TIFF o los archivos de fotogramas, o libera espacio en disco.',
  ],
  [
    'ZIP entry "{0}" started before the previous one ended.',
    'La entrada "{0}" del ZIP empezó antes de que terminara la anterior.',
  ],
  [
    '{0} needs about {1} of memory at one time. That is a lot for a phone: the browser can close this tab before the end, and then the work in progress is lost. If it finishes, the result has the full quality. A computer does it safely.',
    '{0} necesita unos {1} de memoria a la vez. Es mucho para un teléfono: el navegador puede cerrar esta pestaña antes del final, y entonces se pierde el trabajo en curso. Si termina, el resultado tiene la calidad completa. Una computadora lo hace sin riesgo.',
  ],
  // g2-phase1
  [
    '{#0} repeated frame(s): printed once and reused when the video is rebuilt.',
    '{#0} fotograma(s) repetido(s): impresos una vez y reusados cuando se reconstruye el video.',
  ],
  [
    'Extracting this {#0}×{#1} video with the built-in converter',
    'Extraer este video de {#0}×{#1} con el conversor integrado',
  ],
  ['frame {#0} of ~{#1}', 'fotograma {#0} de ~{#1}'],
  ['frame {#0}', 'fotograma {#0}'],
  [
    'Stopped after {#0} frame(s). They stay loaded: change the range or the fps and extract again.',
    'Detenido tras {#0} fotograma(s). Siguen cargados: cambia el rango o los fps y vuelve a extraer.',
  ],
  ['{#0} frames extracted losslessly (PNG).', '{#0} fotogramas extraídos sin pérdida (PNG).'],
  [
    '{#0} frames extracted losslessly (PNG). They keep every bit of the video: 16 bits per channel.',
    '{#0} fotogramas extraídos sin pérdida (PNG). Conservan todos los bits del video: 16 bits por canal.',
  ],
  [
    '{#0} frames read from the video. They are decoded again, at full quality, when the sheets are made.',
    '{#0} fotogramas leídos del video. Se vuelven a decodificar, a calidad completa, al hacer las hojas.',
  ],
  [
    '{#0} frames read from the video. They are decoded again, at full quality, when the sheets are made. They keep every bit of the video: 16 bits per channel.',
    '{#0} fotogramas leídos del video. Se vuelven a decodificar, a calidad completa, al hacer las hojas. Conservan todos los bits del video: 16 bits por canal.',
  ],
  [
    'The frames extracted, but the preview failed: {0}',
    'Los fotogramas se extrajeron, pero la vista previa falló: {0}',
  ],
  ['Extraction failed: {0}', 'La extracción falló: {0}'],
  [
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. This browser cannot decode this codec itself, so the built-in converter will do it: much slower (minutes for a 4K clip). Chrome or Edge decode it in hardware. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. Este navegador no puede decodificar este códec por sí mismo, así que lo hará el conversor integrado: mucho más lento (minutos para un clip 4K). Chrome o Edge lo decodifican por hardware. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. This browser cannot decode this codec itself, so the built-in converter will do it: much slower (minutes for a 4K clip). Chrome or Edge decode it in hardware. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. Este navegador no puede decodificar este códec por sí mismo, así que lo hará el conversor integrado: mucho más lento (minutos para un clip 4K). Chrome o Edge lo decodifican por hardware. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. This browser cannot decode this codec itself, so the built-in converter will do it: much slower (minutes for a 4K clip). Chrome or Edge decode it in hardware. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). This browser decodes it fast only at 8 bits, so keeping them goes through the built-in converter: much slower (minutes for a 4K clip). “Fast 8-bit decode” trades the extra bits for speed. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. Este navegador no puede decodificar este códec por sí mismo, así que lo hará el conversor integrado: mucho más lento (minutos para un clip 4K). Chrome o Edge lo decodifican por hardware. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Este navegador solo lo decodifica rápido a 8 bits, así que conservarlos pasa por el conversor integrado: mucho más lento (minutos para un clip 4K). “Decodificación rápida de 8 bits” cambia los bits extra por velocidad. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). This browser decodes it fast only at 8 bits, so keeping them goes through the built-in converter: much slower (minutes for a 4K clip). “Fast 8-bit decode” trades the extra bits for speed. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s, {#4} fps. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Este navegador solo lo decodifica rápido a 8 bits, así que conservarlos pasa por el conversor integrado: mucho más lento (minutos para un clip 4K). “Decodificación rápida de 8 bits” cambia los bits extra por velocidad. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s. This browser cannot decode this codec itself, so the built-in converter will do it: much slower (minutes for a 4K clip). Chrome or Edge decode it in hardware. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s. Este navegador no puede decodificar este códec por sí mismo, así que lo hará el conversor integrado: mucho más lento (minutos para un clip 4K). Chrome o Edge lo decodifican por hardware. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s. This browser cannot decode this codec itself, so the built-in converter will do it: much slower (minutes for a 4K clip). Chrome or Edge decode it in hardware. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s. Este navegador no puede decodificar este códec por sí mismo, así que lo hará el conversor integrado: mucho más lento (minutos para un clip 4K). Chrome o Edge lo decodifican por hardware. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s. This browser cannot decode this codec itself, so the built-in converter will do it: much slower (minutes for a 4K clip). Chrome or Edge decode it in hardware. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). This browser decodes it fast only at 8 bits, so keeping them goes through the built-in converter: much slower (minutes for a 4K clip). “Fast 8-bit decode” trades the extra bits for speed. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s. Este navegador no puede decodificar este códec por sí mismo, así que lo hará el conversor integrado: mucho más lento (minutos para un clip 4K). Chrome o Edge lo decodifican por hardware. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Este navegador solo lo decodifica rápido a 8 bits, así que conservarlos pasa por el conversor integrado: mucho más lento (minutos para un clip 4K). “Decodificación rápida de 8 bits” cambia los bits extra por velocidad. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{0}: {#1}×{#2}, {#3} s. {#5}-bit video: the frames keep all {#6} bits (16-bit PNG and sheets). This browser decodes it fast only at 8 bits, so keeping them goes through the built-in converter: much slower (minutes for a 4K clip). “Fast 8-bit decode” trades the extra bits for speed. Pick range/fps and press “Extract”.',
    '{0}: {#1}×{#2}, {#3} s. Video de {#5} bits: los fotogramas conservan todos los {#6} bits (PNG y hojas de 16 bits). Este navegador solo lo decodifica rápido a 8 bits, así que conservarlos pasa por el conversor integrado: mucho más lento (minutos para un clip 4K). “Decodificación rápida de 8 bits” cambia los bits extra por velocidad. Elige rango/fps y pulsa “Extraer”.',
  ],
  [
    '{#0} file(s) could not be read and were left out: {1}',
    '{#0} archivo(s) no se pudieron leer y quedaron fuera: {1}',
  ],
  ['{#0} images loaded.', '{#0} imágenes cargadas.'],
  [
    'The frames loaded, but the preview failed: {0}',
    'Los fotogramas se cargaron, pero la vista previa falló: {0}',
  ],
  ['Could not refresh the frames: {0}', 'No se pudieron actualizar los fotogramas: {0}'],
  [
    'Could not analyze the repeated drawings: {0}',
    'No se pudieron analizar los dibujos repetidos: {0}',
  ],
  [
    'Your settings will not be remembered for the next session. {0}',
    'Tus ajustes no se recordarán para la próxima sesión. {0}',
  ],
  [
    'Heads up: this curve was measured with ink {0} and you are now using {1}.',
    'Atención: esta curva se midió con la tinta {0} y ahora usas {1}.',
  ],
  ['ColorBlocker gradient applied ({0}).', 'Degradado de ColorBlocker aplicado ({0}).'],
  [
    'Printer profile applied (scale {#0} % × {#1} %).',
    'Perfil de impresora aplicado (escala {#0} % × {#1} %).',
  ],
  ['Preset “{0}” loaded.', 'Preajuste “{0}” cargado.'],
  ['Preset “{0}” was NOT deleted. {1}', 'El preajuste “{0}” NO se eliminó. {1}'],
  ['Preset “{0}” was NOT deleted.', 'El preajuste “{0}” NO se eliminó.'],
  ['Preset “{0}” was NOT saved. {1}', 'El preajuste “{0}” NO se guardó. {1}'],
  ['Preset “{0}” was NOT saved.', 'El preajuste “{0}” NO se guardó.'],
  ['Preset “{0}” saved.', 'Preajuste “{0}” guardado.'],
  ['PNG sheets {#0} {1}', 'hojas PNG {#0} {1}'],
  ['TIFF sheets {#0} {1}', 'hojas TIFF {#0} {1}'],
  ['PDF {#0} {1}', 'PDF {#0} {1}'],
  ['{#0} frame files {#1} {2}', '{#0} archivos de fotogramas {#1} {2}'],
  ['PNG sheets {#0} {1}, TIFF sheets {#2} {3}', 'hojas PNG {#0} {1}, hojas TIFF {#2} {3}'],
  ['PNG sheets {#0} {1}, PDF {#2} {3}', 'hojas PNG {#0} {1}, PDF {#2} {3}'],
  [
    'PNG sheets {#0} {1}, {#2} frame files {#3} {4}',
    'hojas PNG {#0} {1}, {#2} archivos de fotogramas {#3} {4}',
  ],
  ['TIFF sheets {#0} {1}, PDF {#2} {3}', 'hojas TIFF {#0} {1}, PDF {#2} {3}'],
  [
    'TIFF sheets {#0} {1}, {#2} frame files {#3} {4}',
    'hojas TIFF {#0} {1}, {#2} archivos de fotogramas {#3} {4}',
  ],
  ['PDF {#0} {1}, {#2} frame files {#3} {4}', 'PDF {#0} {1}, {#2} archivos de fotogramas {#3} {4}'],
  [
    'PNG sheets {#0} {1}, TIFF sheets {#2} {3}, PDF {#4} {5}',
    'hojas PNG {#0} {1}, hojas TIFF {#2} {3}, PDF {#4} {5}',
  ],
  [
    'PNG sheets {#0} {1}, TIFF sheets {#2} {3}, {#4} frame files {#5} {6}',
    'hojas PNG {#0} {1}, hojas TIFF {#2} {3}, {#4} archivos de fotogramas {#5} {6}',
  ],
  [
    'PNG sheets {#0} {1}, PDF {#2} {3}, {#4} frame files {#5} {6}',
    'hojas PNG {#0} {1}, PDF {#2} {3}, {#4} archivos de fotogramas {#5} {6}',
  ],
  [
    'TIFF sheets {#0} {1}, PDF {#2} {3}, {#4} frame files {#5} {6}',
    'hojas TIFF {#0} {1}, PDF {#2} {3}, {#4} archivos de fotogramas {#5} {6}',
  ],
  [
    'PNG sheets {#0} {1}, TIFF sheets {#2} {3}, PDF {#4} {5}, {#6} frame files {#7} {8}',
    'hojas PNG {#0} {1}, hojas TIFF {#2} {3}, PDF {#4} {5}, {#6} archivos de fotogramas {#7} {8}',
  ],
  [
    'Estimated ZIP: up to {0} ({1}). This browser has about {2} of disk for it.',
    'ZIP estimado: hasta {0} ({1}). Este navegador tiene unos {2} de disco para él.',
  ],
  [
    'Estimated ZIP: up to {0} ({1}). This browser has about {2} of disk for it. That does not fit: generate fewer sheets at a time, or turn off TIFF or the frame files.',
    'ZIP estimado: hasta {0} ({1}). Este navegador tiene unos {2} de disco para él. Eso no cabe: genera menos hojas a la vez, o desactiva TIFF o los archivos de fotogramas.',
  ],
  [
    'Estimated ZIP: up to {0} ({1}). This browser keeps the ZIP in memory while it is made.',
    'ZIP estimado: hasta {0} ({1}). Este navegador guarda el ZIP en memoria mientras se hace.',
  ],
  [
    'Estimated ZIP: up to {0} (). This browser keeps the ZIP in memory while it is made.',
    'ZIP estimado: hasta {0} (). Este navegador guarda el ZIP en memoria mientras se hace.',
  ],
  [
    'Estimated ZIP: up to {0} (). This browser has about {2} of disk for it.',
    'ZIP estimado: hasta {0} (). Este navegador tiene unos {2} de disco para él.',
  ],
  ['Estimated ZIP: up to {0} ({1}).', 'ZIP estimado: hasta {0} ({1}).'],
  ['This browser has about {0} of disk for it.', 'Este navegador tiene unos {0} de disco para él.'],
  [
    'Done: {#0} sheet(s), {1}, written to disk. Print at 100 % (no “fit to page”).',
    'Listo: {#0} hoja(s), {1}, escrito en disco. Imprime al 100 % (sin “ajustar a la página”).',
  ],
  [
    'Done: {#0} sheet(s), {1}. Print at 100 % (no “fit to page”).',
    'Listo: {#0} hoja(s), {1}. Imprime al 100 % (sin “ajustar a la página”).',
  ],
  ['Generation failed: {0}', 'La generación falló: {0}'],
  ['sheet {#0} / {#1}', 'hoja {#0} / {#1}'],
  ['grid {#0}×{#1} (swapped by best fit)', 'cuadrícula {#0}×{#1} (invertida por mejor ajuste)'],
  ['grid {#0}×{#1}', 'cuadrícula {#0}×{#1}'],
  ['{#0} frames on {#1} sheet(s)', '{#0} fotogramas en {#1} hoja(s)'],
  [
    '{#0} sheets exceed the {#1} that marker identity can distinguish. Enable "Add a QR code per frame" in Registration: QRs identify any number of sheets.',
    '{#0} hojas superan las {#1} que la identidad de los marcadores puede distinguir. Activa "Agregar un código QR por fotograma" en Registro: los QR identifican cualquier número de hojas.',
  ],
  ['{#0} frames loaded', '{#0} fotogramas cargados'],
  ['{#0} selected', '{#0} seleccionados'],
  ['{#0} to print', '{#0} para imprimir'],
  ['Try it with a {#0}-frame example', 'Pruébalo con un ejemplo de {#0} fotogramas'],
  [
    '{#0} example frames ready. Press “Generate sheets”, then go to ② and simulate the scans: the whole loop without printing anything.',
    '{#0} fotogramas de ejemplo listos. Pulsa “Generar hojas”, luego ve a ② y simula los escaneos: el ciclo completo sin imprimir nada.',
  ],
  ['Could not build the example: {0}', 'No se pudo crear el ejemplo: {0}'],
  ['sheet {#0} ready', 'hoja {#0} lista'],
  ['sheet {#0}: decoding {#1} frame(s)…', 'hoja {#0}: decodificando {#1} fotograma(s)…'],
  ['frame files {#0}/{#1}', 'archivos de fotogramas {#0}/{#1}'],
  // g3-phase2
  [
    '✔ {0}: “{1}” · mode {2} · {#3} sheet(s) · {#4} expected frames',
    '✔ {0}: “{1}” · modo {2} · {#3} hoja(s) · {#4} fotogramas esperados',
  ],
  [
    '✔ {0}: mode {1} · {#2} sheet(s) · {#3} expected frames',
    '✔ {0}: modo {1} · {#2} hoja(s) · {#3} fotogramas esperados',
  ],
  [
    '✔ “{0}” · mode {1} · {#2} sheet(s) · {#3} expected frames',
    '✔ “{0}” · modo {1} · {#2} hoja(s) · {#3} fotogramas esperados',
  ],
  [
    '✔ mode {0} · {#1} sheet(s) · {#2} expected frames',
    '✔ modo {0} · {#1} hoja(s) · {#2} fotogramas esperados',
  ],
  ['mode {0}', 'modo {0}'],
  ['{#0} sheet(s)', '{#0} hoja(s)'],
  ['{#0} expected frames', '{#0} fotogramas esperados'],
  ['Could not read the layout: {0}', 'No se pudo leer el layout: {0}'],
  ['detected: {#0}+', 'detectada: {#0}+'],
  [
    'Reprocess the {#0} loaded scan(s) with the current options',
    'Reprocesar los {#0} escaneo(s) cargado(s) con las opciones actuales',
  ],
  ['The scan “{0}”', 'El escaneo “{0}”'],
  ['{#0} GB RAM (set by you)', '{#0} GB de RAM (indicada por ti)'],
  [
    '{#0} GB RAM (set by you; a phone tab counts 4 GB at most)',
    '{#0} GB de RAM (indicada por ti; una pestaña de teléfono cuenta 4 GB como máximo)',
  ],
  [
    '{#0}+ GB RAM (browser estimate; counting {#1} GB, because a phone tab gets less)',
    '{#0}+ GB de RAM (estimación del navegador; se cuentan {#1} GB, porque una pestaña de teléfono recibe menos)',
  ],
  ['{#0}+ GB RAM (browser estimate)', '{#0}+ GB de RAM (estimación del navegador)'],
  [
    'RAM not reported (assuming {#0} GB, because a phone tab gets little)',
    'RAM no informada (se suponen {#0} GB, porque una pestaña de teléfono recibe poca)',
  ],
  [
    'RAM not reported (assuming {#0} GB; set yours in Options)',
    'RAM no informada (se suponen {#0} GB; pon la tuya en Opciones)',
  ],
  [
    'This machine: {0} cores, {1}, GPU straightening on. Processing {#2} scans at a time to stay inside memory.',
    'Esta máquina: {0} núcleos, {1}, enderezado en GPU activado. Procesando {#2} escaneos a la vez para caber en la memoria.',
  ],
  [
    'This machine: {0} cores, {1}, GPU straightening on. Processing {#2} scan at a time to stay inside memory.',
    'Esta máquina: {0} núcleos, {1}, enderezado en GPU activado. Procesando {#2} escaneo a la vez para caber en la memoria.',
  ],
  [
    'This machine: {0} cores, {1}, GPU straightening off. Processing {#2} scans at a time to stay inside memory.',
    'Esta máquina: {0} núcleos, {1}, enderezado en GPU desactivado. Procesando {#2} escaneos a la vez para caber en la memoria.',
  ],
  [
    'This machine: {0} cores, {1}, GPU straightening off. Processing {#2} scan at a time to stay inside memory.',
    'Esta máquina: {0} núcleos, {1}, enderezado en GPU desactivado. Procesando {#2} escaneo a la vez para caber en la memoria.',
  ],
  [
    'cancelling: finishing the scan(s) already running ({#0}/{#1} done)',
    'cancelando: terminando los escaneos ya en curso ({#0}/{#1} hechos)',
  ],
  ['{#0}/{#1} scans', '{#0}/{#1} escaneos'],
  ['Error in one scan: {0}', 'Error en un escaneo: {0}'],
  [
    'Cancelled after {#0} of {#1} scan(s). Those are in the report; the rest stay loaded for Reprocess.',
    'Cancelado tras {#0} de {#1} escaneo(s). Esos están en el informe; el resto queda cargado para Reprocesar.',
  ],
  ['Could not process the scans: {0}', 'No se pudieron procesar los escaneos: {0}'],
  [
    '“{0}” is no longer loaded: drop it again to reprocess it.',
    '“{0}” ya no está cargado: suéltalo de nuevo para reprocesarlo.',
  ],
  ['reprocessing {0}…', 'reprocesando {0}…'],
  [
    '“{0}” → sheet {#1}: {#2} frame(s) cropped.',
    '“{0}” → hoja {#1}: {#2} fotograma(s) recortado(s).',
  ],
  ['“{0}” still has no sheet: {1}', '“{0}” sigue sin hoja: {1}'],
  ['Could not reprocess “{0}”: {1}', 'No se pudo reprocesar “{0}”: {1}'],
  ['Sheet {#0}', 'Hoja {#0}'],
  ['Sheet {#0} · {1}', 'Hoja {#0} · {1}'],
  ['Sheet {#0} · {1} · already taken by {2}', 'Hoja {#0} · {1} · ya tomada por {2}'],
  ['Sheet {#0} · already taken by {1}', 'Hoja {#0} · ya tomada por {1}'],
  ['already taken by {0}', 'ya tomada por {0}'],
  [
    '{0}: green = marker found, red = missing, blue = frames, orange = QRs',
    '{0}: verde = marcador encontrado, rojo = faltante, azul = fotogramas, naranja = QRs',
  ],
  ['±{#0} mm · mirrored', '±{#0} mm · espejado'],
  ['{#0} scan with no sheet identified', '{#0} escaneo sin hoja identificada'],
  ['{#0} scans with no sheet identified', '{#0} escaneos sin hoja identificada'],
  [
    'The markers straightened the sheet, but nothing identified it: the QR is painted over or unreadable, or the project identifies sheets by QR only. {0}, or recognise the drawings in the thumbnails, and pick the sheet here. The scan is reprocessed at once with the right labels.',
    'Los marcadores enderezaron la hoja, pero nada la identificó: el QR está pintado encima o es ilegible, o el proyecto identifica las hojas solo por QR. {0}, o reconoce los dibujos en las miniaturas, y elige la hoja aquí. El escaneo se reprocesa al momento con las etiquetas correctas.',
  ],
  [
    'Sheet {#0}: {1} — only the frames of the last one are kept.',
    'Hoja {#0}: {1} — solo se conservan los fotogramas del último.',
  ],
  ['Missing frames ({#0}):', 'Fotogramas faltantes ({#0}):'],
  [
    '{#0} recovered frames in memory (ready for the Video phase).',
    '{#0} fotogramas recuperados en memoria (listos para la fase Video).',
  ],
  ['Could not build the ZIP: {0}', 'No se pudo crear el ZIP: {0}'],
  ['{#0} originals loaded.', '{#0} originales cargados.'],
  [
    'No original copy (cannot be reprinted): {0}',
    'Sin copia original (no se puede reimprimir): {0}',
  ],
  [
    'Rescue sheets generated with {#0} frame(s). Print, paint/expose, scan and process against the rescue layout.',
    'Hojas de rescate generadas con {#0} fotograma(s). Imprime, pinta/expón, escanea y procesa con el layout de rescate.',
  ],
  ['Rescue failed: {0}', 'El rescate falló: {0}'],
  [
    '{#0} simulated scan(s): your sheets, printed and scanned back crooked.',
    '{#0} escaneo(s) simulado(s): tus hojas, impresas y vueltas a escanear torcidas.',
  ],
  ['Could not simulate the scans: {0}', 'No se pudieron simular los escaneos: {0}'],
  // g4-phase34
  ['Profile “{0}” was NOT saved. {1}', 'El perfil “{0}” NO se guardó. {1}'],
  [
    'Profile “{0}” saved. You can now use it in phase ①.',
    'Perfil “{0}” guardado. Ya puedes usarlo en la fase ①.',
  ],
  ['Could not build the test page: {0}', 'No se pudo crear la página de prueba: {0}'],
  ['Measured scale: {#0} % × {#1} %', 'Escala medida: {#0} % × {#1} %'],
  [
    'Smallest detected marker: {0} mm → use ≥ {#1} mm',
    'Marcador más pequeño detectado: {0} mm → usa ≥ {#1} mm',
  ],
  [
    'Smallest readable QR: {0} mm → use ≥ {#1} mm',
    'QR legible más pequeño: {0} mm → usa ≥ {#1} mm',
  ],
  ['Could not build the chart: {0}', 'No se pudo crear la carta: {0}'],
  [
    'Measured dynamic range: {#0} % · 256-point curve built.',
    'Rango dinámico medido: {#0} % · curva de 256 puntos creada.',
  ],
  ['Could not build the ColorBlocker chart: {0}', 'No se pudo crear la carta ColorBlocker: {0}'],
  ['Import failed: {0}', 'La importación falló: {0}'],
  ['From 1 to {#0}.', 'De 1 a {#0}.'],
  [
    'Audio from {0} (dropped here), from {#1} s of it.',
    'Audio de {0} (soltado aquí), desde {#1} s.',
  ],
  ['Audio from {0} (phase ①), from {#1} s of it.', 'Audio de {0} (fase ①), desde {#1} s.'],
  [
    'Audio from {0} (dropped here), from {#1} s of it. The frames were extracted at {#2} fps: at {#3} fps the drawings run {#4}× faster than the sound and drift apart. Use {#5} fps to keep them together.',
    'Audio de {0} (soltado aquí), desde {#1} s. Los fotogramas se extrajeron a {#2} fps: a {#3} fps los dibujos van {#4}× más rápido que el sonido y se desfasan. Usa {#5} fps para mantenerlos juntos.',
  ],
  [
    'Audio from {0} (dropped here), from {#1} s of it. The frames were extracted at {#2} fps: at {#3} fps the drawings run {#4}× slower than the sound and drift apart. Use {#5} fps to keep them together.',
    'Audio de {0} (soltado aquí), desde {#1} s. Los fotogramas se extrajeron a {#2} fps: a {#3} fps los dibujos van {#4}× más lento que el sonido y se desfasan. Usa {#5} fps para mantenerlos juntos.',
  ],
  [
    'Audio from {0} (phase ①), from {#1} s of it. The frames were extracted at {#2} fps: at {#3} fps the drawings run {#4}× faster than the sound and drift apart. Use {#5} fps to keep them together.',
    'Audio de {0} (fase ①), desde {#1} s. Los fotogramas se extrajeron a {#2} fps: a {#3} fps los dibujos van {#4}× más rápido que el sonido y se desfasan. Usa {#5} fps para mantenerlos juntos.',
  ],
  [
    'Audio from {0} (phase ①), from {#1} s of it. The frames were extracted at {#2} fps: at {#3} fps the drawings run {#4}× slower than the sound and drift apart. Use {#5} fps to keep them together.',
    'Audio de {0} (fase ①), desde {#1} s. Los fotogramas se extrajeron a {#2} fps: a {#3} fps los dibujos van {#4}× más lento que el sonido y se desfasan. Usa {#5} fps para mantenerlos juntos.',
  ],
  [
    'The frames were extracted at {#0} fps: at {#1} fps the drawings run {#2}× faster than the sound and drift apart.',
    'Los fotogramas se extrajeron a {#0} fps: a {#1} fps los dibujos van {#2}× más rápido que el sonido y se desfasan.',
  ],
  [
    'The frames were extracted at {#0} fps: at {#1} fps the drawings run {#2}× slower than the sound and drift apart.',
    'Los fotogramas se extrajeron a {#0} fps: a {#1} fps los dibujos van {#2}× más lento que el sonido y se desfasan.',
  ],
  ['Use {#0} fps to keep them together.', 'Usa {#0} fps para mantenerlos juntos.'],
  [
    '{#0} of {#1} drawings copied as they are, {#2} brought to that size and depth',
    '{#0} de {#1} dibujos copiados tal cual, {#2} llevados a ese tamaño y profundidad',
  ],
  [
    '{#0} of {#1} drawings copied as they are, {#2} brought to that size and depth ({#3} of a very different size, scaled to fit)',
    '{#0} de {#1} dibujos copiados tal cual, {#2} llevados a ese tamaño y profundidad ({#3} de un tamaño muy distinto, escalados para encajar)',
  ],
  [
    'Lossless: {#0}×{#1}, {3}, {#2} frames; {4}.',
    'Sin pérdida: {#0}×{#1}, {3}, {#2} fotogramas; {4}.',
  ],
  ['Some frames cannot be read: {0}', 'Algunos fotogramas no se pueden leer: {0}'],
  [
    'Layout: {0} · {#1} positions in the timeline',
    'Layout: {0} · {#1} posiciones en la línea de tiempo',
  ],
  [
    'Layout: {0} · no positions in the timeline',
    'Layout: {0} · ninguna posición en la línea de tiempo',
  ],
  [
    '{#0} frames available (phase ② in memory + whatever you drop here).',
    '{#0} fotogramas disponibles (fase ② en memoria + lo que sueltes aquí).',
  ],
  ['Missing {#0}:', 'Faltan {#0}:'],
  ['All {#0} video positions have a frame.', 'Las {#0} posiciones del video tienen fotograma.'],
  [
    'Frames missing: {#0}. Each gap shows the drawing before it. Continue?',
    'Fotogramas que faltan: {#0}. Cada hueco muestra el dibujo anterior. ¿Continuar?',
  ],
  [
    'Frames missing: {#0}. The video skips the gaps and their sound. Continue?',
    'Fotogramas que faltan: {#0}. El video salta los huecos y su sonido. ¿Continuar?',
  ],
  [
    'Frames missing: {#0}. The video skips the gaps, and the sound plays without cuts. Continue?',
    'Fotogramas que faltan: {#0}. El video salta los huecos y el sonido suena sin cortes. ¿Continuar?',
  ],
  ['Compressing one {#0}×{#1} frame', 'Comprimir un fotograma de {#0}×{#1}'],
  ['Converting one frame to {#0}×{#1}', 'Convertir un fotograma a {#0}×{#1}'],
  ['Converting one frame to {#0}×{#1} at 16 bits', 'Convertir un fotograma a {#0}×{#1} a 16 bits'],
  [
    'bringing {#0} drawing(s) to one size and depth: {#1}/{#2}',
    'llevando {#0} dibujo(s) a un tamaño y profundidad: {#1}/{#2}',
  ],
  ['reading the sound of the original… {#0}%', 'leyendo el sonido del original… {#0}%'],
  ['writing frame {#0}/{#1}', 'escribiendo fotograma {#0}/{#1}'],
  ['compressing frame {#0}/{#1}', 'comprimiendo fotograma {#0}/{#1}'],
  [
    '{0} has no audio track this browser can read: the video is silent.',
    '{0} no tiene una pista de audio que este navegador pueda leer: el video sale mudo.',
  ],
  ['{0}: the video is silent.', '{0}: el video sale mudo.'],
  ['MP4 saved: {#0}×{#1}, {3}, {#2} fps, {4}.', 'MP4 guardado: {#0}×{#1}, {3}, {#2} fps, {4}.'],
  [
    'MP4 saved: {#0}×{#1}, {3}, {#2} fps, {4}, with the original sound.',
    'MP4 guardado: {#0}×{#1}, {3}, {#2} fps, {4}, con el sonido original.',
  ],
  [
    'MP4 saved: {#0}×{#1}, {3}, {#2} fps, {4}. Note: {5}.',
    'MP4 guardado: {#0}×{#1}, {3}, {#2} fps, {4}. Nota: {5}.',
  ],
  [
    'MP4 saved: {#0}×{#1}, {3}, {#2} fps, {4}, with the original sound. Note: {5}.',
    'MP4 guardado: {#0}×{#1}, {3}, {#2} fps, {4}, con el sonido original. Nota: {5}.',
  ],
  [
    'Lossless MOV saved: {#0}×{#1}, {#2} fps, {3}. It opens in DaVinci Resolve, Premiere, After Effects, VLC and IINA; QuickTime and phones do not play PNG video, so watch it in the preview.',
    'MOV sin pérdida guardado: {#0}×{#1}, {#2} fps, {3}. Se abre en DaVinci Resolve, Premiere, After Effects, VLC e IINA; QuickTime y los teléfonos no reproducen video PNG, así que míralo en la vista previa.',
  ],
  [
    'Lossless MOV saved: {#0}×{#1}, {#2} fps, {3}, with the original sound. It opens in DaVinci Resolve, Premiere, After Effects, VLC and IINA; QuickTime and phones do not play PNG video, so watch it in the preview.',
    'MOV sin pérdida guardado: {#0}×{#1}, {#2} fps, {3}, con el sonido original. Se abre en DaVinci Resolve, Premiere, After Effects, VLC e IINA; QuickTime y los teléfonos no reproducen video PNG, así que míralo en la vista previa.',
  ],
  [
    'Lossless frames saved: {#0} PNG files, {2}. Import them as an image sequence at {#1} fps.',
    'Fotogramas sin pérdida guardados: {#0} archivos PNG, {2}. Impórtalos como secuencia de imágenes a {#1} fps.',
  ],
  [
    'Lossless frames saved: {#0} PNG files, {2}, with the original sound. Import them as an image sequence at {#1} fps.',
    'Fotogramas sin pérdida guardados: {#0} archivos PNG, {2}, con el sonido original. Impórtalos como secuencia de imágenes a {#1} fps.',
  ],
  ['Saving failed: {0}', 'No se pudo guardar: {0}'],
  // g5-media
  ['{0} did not answer in {#1} s.', '{0} no respondió en {#1} s.'],
  [
    'Opening the original did not answer in {#0} s.',
    'La apertura del original no respondió en {#0} s.',
  ],
  ['The original did not answer in {#0} s.', 'El original no respondió en {#0} s.'],
  [
    'The sound decoder did not answer in {#0} s.',
    'El decodificador de sonido no respondió en {#0} s.',
  ],
  [
    '{0} has no audio track this browser can read',
    '{0} no tiene una pista de audio que este navegador pueda leer',
  ],
  ['the sound of {0} does not reach {#1} s', 'el sonido de {0} no llega a {#1} s'],
  ['{0} decoded no sound for that range', '{0} no decodificó sonido en ese rango'],
  ['the sound of {0} could not be decoded ({1})', 'no se pudo decodificar el sonido de {0} ({1})'],
  [
    'The MOV muxer wrote {#0} of {#1} frames.',
    'El multiplexor MOV escribió {#0} de {#1} fotogramas.',
  ],
  [
    'Frame {#0} cannot be decoded by this browser: {1}',
    'El fotograma {#0} no se puede decodificar en este navegador: {1}',
  ],
  ['fixed {#0} Mbps', '{#0} Mbps fijos'],
  [
    'Compressed MP4 (H.264 where this browser has it): {#0}×{#1}, {#2} frames, {3}. About {#4} MB of picture. It loses detail on purpose; keep the lossless MOV or PNG frames as the master.',
    'MP4 comprimido (H.264 donde este navegador lo tiene): {#0}×{#1}, {#2} fotogramas, {3}. Unos {#4} MB de imagen. Pierde detalle a propósito; conserva el MOV o los fotogramas PNG sin pérdida como máster.',
  ],
  [
    'Compressed MP4 (H.264 where this browser has it): {#0}×{#1}, {#2} frames, {3}. The bitrate follows the picture: still drawings take little, busy ones more. It loses detail on purpose; keep the lossless MOV or PNG frames as the master.',
    'MP4 comprimido (H.264 donde este navegador lo tiene): {#0}×{#1}, {#2} fotogramas, {3}. El bitrate sigue a la imagen: los dibujos quietos ocupan poco, los cargados más. Pierde detalle a propósito; conserva el MOV o los fotogramas PNG sin pérdida como máster.',
  ],
  [
    'Compressed MP4 (H.264 where this browser has it): {#0}×{#1} (the frames are {#2}×{#3}; a white edge fills the difference, the drawing is not resized), {#4} frames, {5}. About {#6} MB of picture. It loses detail on purpose; keep the lossless MOV or PNG frames as the master.',
    'MP4 comprimido (H.264 donde este navegador lo tiene): {#0}×{#1} (los fotogramas son de {#2}×{#3}; un borde blanco llena la diferencia, el dibujo no se redimensiona), {#4} fotogramas, {5}. Unos {#6} MB de imagen. Pierde detalle a propósito; conserva el MOV o los fotogramas PNG sin pérdida como máster.',
  ],
  [
    'Compressed MP4 (H.264 where this browser has it): {#0}×{#1} (the frames are {#2}×{#3}; a white edge fills the difference, the drawing is not resized), {#4} frames, {5}. The bitrate follows the picture: still drawings take little, busy ones more. It loses detail on purpose; keep the lossless MOV or PNG frames as the master.',
    'MP4 comprimido (H.264 donde este navegador lo tiene): {#0}×{#1} (los fotogramas son de {#2}×{#3}; un borde blanco llena la diferencia, el dibujo no se redimensiona), {#4} fotogramas, {5}. El bitrate sigue a la imagen: los dibujos quietos ocupan poco, los cargados más. Pierde detalle a propósito; conserva el MOV o los fotogramas PNG sin pérdida como máster.',
  ],
  ['About {#0} MB of picture.', 'Unos {#0} MB de imagen.'],
  [
    'This browser cannot compress video at {#0}×{#1}. Save it lossless (MOV or PNG frames): that works at any size.',
    'Este navegador no puede comprimir video a {#0}×{#1}. Guárdalo sin pérdida (MOV o fotogramas PNG): eso funciona a cualquier tamaño.',
  ],
  [
    'this browser cannot encode 1-channel sound at {#0} Hz for MP4',
    'este navegador no puede codificar sonido de 1 canal a {#0} Hz para MP4',
  ],
  [
    'this browser cannot encode {#0}-channel sound at {#1} Hz for MP4',
    'este navegador no puede codificar sonido de {#0} canales a {#1} Hz para MP4',
  ],
  [
    'Invalid time range: start ({0}) must come before end ({1}).',
    'Rango de tiempo no válido: el inicio ({0}) debe ir antes del final ({1}).',
  ],
  [
    'Invalid time range: start ({0}) must come before end ({1}). This video lasts {#2} s.',
    'Rango de tiempo no válido: el inicio ({0}) debe ir antes del final ({1}). Este video dura {#2} s.',
  ],
  ['This video lasts {#0} s.', 'Este video dura {#0} s.'],
  [
    '{0}: this browser can no longer decode the video.',
    '{0}: este navegador ya no puede decodificar el video.',
  ],
  ['{0}: no frame at {#1} s.', '{0}: no hay fotograma en {#1} s.'],
  ['{0}: the decoder stopped early.', '{0}: el decodificador se detuvo antes de tiempo.'],
  [
    'The video converter module is missing on the server: /ffmpeg/{0} came back as {1} (HTTP {#2}). Generate web/public/ffmpeg/ with "npm run build" or "npm run test:e2e"; "npm run dev" does not.',
    'Falta en el servidor el módulo conversor de video: /ffmpeg/{0} llegó como {1} (HTTP {#2}). Genera web/public/ffmpeg/ con "npm run build" o "npm run test:e2e"; "npm run dev" no lo hace.',
  ],
  ['{0} took more than {#1} s', '{0} tardó más de {#1} s'],
  [
    'loading the video converter took more than {#0} s',
    'la carga del conversor de video tardó más de {#0} s',
  ],
  [
    'loading the multithreaded video converter took more than {#0} s',
    'la carga del conversor de video multihilo tardó más de {#0} s',
  ],
  [
    'loading the multithreaded core took more than {#0} s',
    'la carga del núcleo multihilo tardó más de {#0} s',
  ],
  [
    '{0} stopped responding: {#1} s without a sign of life from the in-browser converter. Try again, and if it happens every time, use a lower resolution or split the range.',
    '{0} dejó de responder: {#1} s sin señales de vida del conversor del navegador. Inténtalo de nuevo y, si pasa siempre, usa una resolución más baja o divide el rango.',
  ],
  [
    'The file could not be decoded (unsupported or damaged video). ffmpeg: {0}',
    'No se pudo decodificar el archivo (video no compatible o dañado). ffmpeg: {0}',
  ],
  // g6-rust
  ['Invalid settings: {0}', 'Ajustes no válidos: {0}'],
  ['Invalid frame metadata: {0}', 'Metadatos de fotograma no válidos: {0}'],
  ['Invalid labels: {0}', 'Etiquetas no válidas: {0}'],
  ['Image too large ({#0}×{#1}).', 'Imagen demasiado grande ({#0}×{#1}).'],
  ['Image too large ({#0}×{#1} → {#2}×{#3}).', 'Imagen demasiado grande ({#0}×{#1} → {#2}×{#3}).'],
  ['Invalid video frame description: {0}', 'Descripción de fotograma de video no válida: {0}'],
  [
    'Only {#0} reference markers were detected; at least 3 are needed. Scan the whole page, right side up.',
    'Solo se detectaron {#0} marcadores de referencia; se necesitan al menos 3. Escanea la página entera, al derecho.',
  ],
  [
    'The measured scan scale is impossible (×{#0}). Scan the whole calibration page, right side up, at between 150 and 600 dpi.',
    'La escala medida del escaneo es imposible (×{#0}). Escanea la página de calibración entera, al derecho, entre 150 y 600 dpi.',
  ],
  [
    'The rectified calibration page would be {#0}×{#1} px, too large to process. Rescan the page at a lower dpi.',
    'La página de calibración enderezada mediría {#0}×{#1} px, demasiado grande para procesarla. Vuelve a escanear la página a menos dpi.',
  ],
  [
    'The chart patches are barely distinguishable (range {#0} %). Usually the exposure was too short or too long, or the scan has minimum contrast.',
    'Los parches de la carta apenas se distinguen (rango {#0} %). Normalmente la exposición fue demasiado corta o demasiado larga, o el escaneo tiene un contraste mínimo.',
  ],
  [
    "On your printer, the color {0} blocks UV clearly better than black: use it as the negatives' ink.",
    'En tu impresora, el color {0} bloquea el UV claramente mejor que el negro: úsalo como tinta de los negativos.',
  ],
  [
    "{#0} hue(s) did not follow the chart's nominal order (normal for colors that barely block UV) and were left out.",
    '{#0} matiz(es) no siguieron el orden nominal de la carta (normal en colores que apenas bloquean el UV) y quedaron fuera.',
  ],
  ['Scan {#0} of {#1}: {0}', 'Escaneo {#0} de {#1}: {0}'],
  ['Average of {#0} prints.', 'Promedio de {#0} copias.'],
  [
    'The curve applied to the chart must have 256 points; it has {#0}.',
    'La curva aplicada a la carta debe tener 256 puntos; tiene {#0}.',
  ],
  [
    'Your {#0} prints differ by about {#1} % on average: the coating, the exposure or the development changed between them. The curve uses their average.',
    'Tus {#0} copias difieren en promedio un {#1} %: la emulsión, la exposición o el revelado cambiaron entre ellas. La curva usa su promedio.',
  ],
  ['Unrecognized format: {0}', 'Formato no reconocido: {0}'],
  ['Could not decode the image: {0}', 'No se pudo decodificar la imagen: {0}'],
  [
    'Image too heavy to decode ({#0}×{#1} at {#2} bits per channel needs about {#3} MB, and the browser can address at most {#4} MB). Scan it at a lower dpi, or at 8 bits per channel.',
    'Imagen demasiado pesada para decodificar ({#0}×{#1} a {#2} bits por canal necesita unos {#3} MB, y el navegador puede direccionar como máximo {#4} MB). Escanéala a menos dpi, o a 8 bits por canal.',
  ],
  ['PNG encode failed: {0}', 'Falló la codificación PNG: {0}'],
  ['Could not read the image header: {0}', 'No se pudo leer la cabecera de la imagen: {0}'],
  ['Impossible output size ({#0}×{#1}).', 'Tamaño de salida imposible ({#0}×{#1}).'],
  [
    'The PDF would be {#0} GB, and a PDF cannot point past 9.3 GB: generate the sheets in several parts (Sheets to include), or leave the PDF out and print the PNG or TIFF sheets.',
    'El PDF pesaría {#0} GB, y un PDF no puede apuntar más allá de 9.3 GB: genera las hojas en varias partes (Hojas a generar), o deja fuera el PDF e imprime las hojas PNG o TIFF.',
  ],
  [
    'The label is too long for a QR code at error-correction level H: {#0} bytes, and the limit is about {#1}. Shorten the project name or the frame labels.',
    'La etiqueta es demasiado larga para un código QR con nivel de corrección de errores H: {#0} bytes, y el límite es de unos {#1}. Acorta el nombre del proyecto o las etiquetas de los fotogramas.',
  ],
  ['The QR code could not be generated ({0}).', 'No se pudo generar el código QR ({0}).'],
  [
    'The layout declares an impossible canvas ({#0}×{#1} px).',
    'El layout declara un lienzo imposible ({#0}×{#1} px).',
  ],
  [
    'Only {#0} of {#1} markers were detected (minimum: {#2}). Check that the markers are not covered and that the whole sheet is inside the scan.',
    'Solo se detectaron {#0} de {#1} marcadores (mínimo: {#2}). Comprueba que los marcadores no estén tapados y que la hoja entera esté dentro del escaneo.',
  ],
  [
    'Could not estimate the scan scale (s={0}).',
    'No se pudo estimar la escala del escaneo (s={0}).',
  ],
  [
    'Recovered {#0} marker(s) in the guided second pass ({1}).',
    'Se recuperaron {#0} marcador(es) en la segunda pasada guiada ({1}).',
  ],
  [
    'Few consistent points in the alignment ({#0}).',
    'Pocos puntos coherentes en la alineación ({#0}).',
  ],
  [
    'Marker(s) {0} discarded due to inconsistent residual (> {#1} mm).',
    'Marcador(es) {0} descartado(s) por residuo incoherente (> {#1} mm).',
  ],
  [
    'Imprecise alignment (residual ±{#0} mm): the paper probably warped when wet. Crops are corrected locally using nearby markers.',
    'Alineación imprecisa (residuo ±{#0} mm): el papel probablemente se deformó al mojarse. Los recortes se corrigen localmente con los marcadores cercanos.',
  ],
  [
    'The requested rectification is disproportionate ({#0}×{#1} px); check the layout.',
    'El enderezado pedido es desproporcionado ({#0}×{#1} px); revisa el layout.',
  ],
  [
    'Straightening this scan needs about {#0} MB at {#1} bits per channel, and the browser can address at most {#2} MB. Scan at 8 bits per channel, or at a lower dpi.',
    'Enderezar este escaneo necesita unos {#0} MB a {#1} bits por canal, y el navegador puede direccionar como máximo {#2} MB. Escanea a 8 bits por canal, o a menos dpi.',
  ],
  [
    "Sheet {#0} was also claimed by '{1}': the frames of whichever is processed last are the ones that stay.",
    "La hoja {#0} también la reclamó '{1}': los fotogramas del que se procese al final son los que se quedan.",
  ],
  [
    'Sheet {#0} was assigned by hand but does not exist in this layout: falling back to automatic identification.',
    'La hoja {#0} se asignó a mano pero no existe en este layout: se vuelve a la identificación automática.',
  ],
  [
    "No identity found and sheet {#0} was already claimed by '{1}': this scan goes to 'unidentified' to avoid overwriting it.",
    "No se encontró identidad y la hoja {#0} ya la reclamó '{1}': este escaneo va a 'sin identificar' para no sobrescribirla.",
  ],
  ["Empty crop for '{0}'.", "Recorte vacío para '{0}'."],
  [
    "'{0}': the layout asks to restore an impossible original size ({#1}×{#2} px); the crop is left at scan resolution.",
    "'{0}': el layout pide restaurar un tamaño original imposible ({#1}×{#2} px); el recorte se deja a la resolución del escaneo.",
  ],
  [
    'The requested sheet is unreasonably large ({#0}×{#1} px). Lower the DPI or the paper size.',
    'La hoja pedida es desmesuradamente grande ({#0}×{#1} px). Baja los DPI o el tamaño del papel.',
  ],
  [
    '{#0} mm markers: for cyanotype, ≥ 10 mm is recommended (small ones degrade with the chemistry).',
    'Marcadores de {#0} mm: para cianotipia, se recomienda ≥ 10 mm (los pequeños se degradan con la química).',
  ],
  [
    '{#0} mm QRs: for cyanotype, ≥ 12 mm is recommended so they stay readable after exposing and washing.',
    'QR de {#0} mm: para cianotipia, se recomienda ≥ 12 mm para que sigan legibles tras exponer y lavar.',
  ],
  [
    '{#0} mm marker margin: for cyanotype, ≥ 6 mm is advised because paper edges collect brush stains and tears.',
    'Margen de marcadores de {#0} mm: para cianotipia, se aconseja ≥ 6 mm porque los bordes del papel acumulan manchas de pincel y roturas.',
  ],
  [
    '{#0} mm inked halo: in ink-saving mode, ≥ 4 mm is advised so markers and QRs sit on guaranteed white.',
    'Halo entintado de {#0} mm: en modo de ahorro de tinta, se aconseja ≥ 4 mm para que marcadores y QR queden sobre blanco garantizado.',
  ],
  [
    "The blocker color ({0}) is very light: it may let UV through and fog the print's backgrounds/halos.",
    'El color bloqueador ({0}) es muy claro: puede dejar pasar el UV y velar los fondos/halos de la copia.',
  ],
  ['Unknown colour matrix "{0}".', 'Matriz de color desconocida "{0}".'],
  [
    'Plane stride {#0} is shorter than its row ({#1} bytes).',
    'El stride {#0} del plano es menor que su fila ({#1} bytes).',
  ],
  [
    'The frame buffer is {#0} bytes, but its planes need {#1}.',
    'El búfer del fotograma tiene {#0} bytes, pero sus planos necesitan {#1}.',
  ],
  ['Video frame too large ({#0}×{#1}).', 'Fotograma de video demasiado grande ({#0}×{#1}).'],
  ['Unsupported video pixel format {0}.', 'Formato de píxel de video {0} no admitido.'],
  ['{0} has {#1} planes, {#2} were given.', '{0} tiene {#1} planos, se dieron {#2}.'],
  ['Unsupported rotation {#0}°.', 'Rotación de {#0}° no admitida.'],
];

/** Lo que no es lenguaje y se deja como está: nombres de archivo, medidas,
 *  siglas y nombres propios. */
export const IGNORE: RegExp[] = [
  // un nombre de archivo, solo o con su tamaño: «demo.zip», «a.tif · 12 MB»
  /^[^\s]+\.[A-Za-z0-9]{2,5}$/,
  // números con unidades y siglas: «1440 × 900 px», «24 fps», «12.3 MB»
  /^[\d\s.,:×x%/·+\-–—()#~±≈<>=]*(?:(?:px|mm|cm|in|pt|dpi|ppi|fps|Mbps|kbps|MB|GB|KB|kB|bytes|s|ms|bit|bits|Hz|kHz)[\d\s.,:×x%/·+\-–—()#~±≈<>=]*)?$/,
  // la etiqueta de un fotograma: «demo_001», «frame-12»
  /^\S+[_\-.]\d+$/,
  // una lista de etiquetas: «demo_001, demo_002, …»
  /^[^,]*[A-Za-z][_\-.]\d+(, [^,]*[A-Za-z][_\-.]\d+)*(,? …)?$/,
  // formatos, códecs y nombres propios, solos
  /^(PNG|PDF|TIFF?|MOV|MP4|ZIP|JSON|AVI|HEVC|H\.264|H\.265|AV1|VP9|ProRes|WebGPU|WebAssembly|CPU|GPU|RGB|RGBA|CMYK|UV|QR|ArUco|A[3-6]|B[45]|MXM|MXM Studio|Rust|GitHub|Instagram|Kamila|Sebastian López|CC BY-NC-SA 4\.0|Easy Digital Negatives|ColorBlocker|DICT_\w+|EN|ES|English|Español)$/,
];
