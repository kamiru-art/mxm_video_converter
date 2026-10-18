// La ayuda en español (ver help.ts): la misma página, frase por frase.

export const HELP_ES = `
<h2>Cómo funciona</h2>
<ol class="steps">
  <li><span class="step-num">01</span><strong>Video de entrada</strong><span>un video o una carpeta de imágenes</span></li>
  <li><span class="step-num">02</span><strong>Hojas de contactos</strong><span>imprimibles, con marcadores de registro</span></li>
  <li><span class="step-num">03</span><strong>Pinta o expón</strong><span>pinta sobre papel, o expón cianotipos desde negativos en película</span></li>
  <li><span class="step-num">04</span><strong>Escanea</strong><span>en cualquier orden, en cualquier orientación</span></li>
  <li><span class="step-num">05</span><strong>Procesado automático</strong><span>la app endereza, identifica y recorta cada fotograma</span></li>
  <li><span class="step-num">06</span><strong>Video</strong><span>tus fotogramas juntos de nuevo como video</span></li>
</ol>

<div class="cols">
<div>

<h3>① Hojas</h3>
<p>Para probar la app sin tus propios archivos, pulsa <strong>&ldquo;Pruébalo con un
ejemplo de 6 fotogramas&rdquo;</strong>. Crea una animación corta. Genera las
hojas y luego, en ②, pulsa <strong>&ldquo;Simúlalos con las hojas de esta
sesión&rdquo;</strong> para obtener escaneos falsos de ellas.</p>
<p>Suelta un video o una carpeta de imágenes. Elige cuántos fotogramas por
segundo quieres, o todos para animación fotograma a fotograma.</p>
<p>Los videos de algunas cámaras traen detalle de color extra. La app lo
conserva, pero en algunos navegadores eso hace que la carga sea lenta. Si es
demasiado lenta, activa <strong>Decodificación rápida de 8 bits</strong>: es más
rápida, con un poco menos de detalle de color.</p>
<p>Deja activados los <strong>marcadores de registro</strong>. Son los pequeños
cuadrados alrededor de los bordes de la hoja. La app los usa para enderezar cada
escaneo y para saber qué hoja es, así que puedes escanear en cualquier orden. Con 8
marcadores puedes pintar encima de algunos: la app necesita al menos 3 limpios
para enderezar el escaneo.</p>
<p>Los marcadores pueden distinguir hasta 144 hojas con los ajustes predeterminados, y
la vista previa te avisa si te pasas. Para proyectos más largos, activa
<strong>&ldquo;Agregar un código QR por fotograma&rdquo;</strong> en la sección
Registro.</p>
<p>Puedes exportar las hojas como <strong>PNG</strong>, <strong>PDF</strong>
(listo para imprimir), <strong>TIFF</strong>, o varios a la vez. La descarga
siempre incluye un archivo que termina en <code>_layout.json</code>, que
necesitarás en ②. <strong>Imprime siempre al 100&nbsp;%</strong>, nunca &ldquo;ajustar a la página&rdquo;.</p>

<h3>Modo cianotipia</h3>
<p>El modo cianotipia hace <strong>negativos para imprimir en película
transparente</strong>. La imagen se invierte y se refleja. Si calibraste (ver
Calibración), se imprime en tu mejor tinta que bloquea el UV y se ajusta con
tu curva de cianotipia. El modo <strong>AHORRO DE TINTA</strong> deja el fondo
transparente y solo imprime un borde de tinta alrededor de cada marcador, así que usa mucha
menos tinta. Activa <strong>Simular la copia azul final</strong> para ver en la
vista previa cómo se verá la copia azul.</p>
<p>El pequeño triángulo junto al marcador de arriba a la izquierda te dice en qué
sentido salió la copia. En una copia azul correcta apunta a la <strong>derecha</strong>. Si
apunta a la izquierda, la película estaba volteada cuando la expusiste. La app lo
corrige sola cuando lee el escaneo.</p>

<h3>Privacidad</h3>
<p>Todo ocurre <strong>en tu navegador</strong>. Tus videos y escaneos
nunca salen de tu computadora. No hay cuentas ni límites, y una vez que la
página ha cargado también funciona sin conexión. Puedes <strong>instalarla</strong> como
app: en Chrome y Edge, usa el ícono de instalar en la barra de direcciones; en iPhone
y iPad, Compartir → Agregar a pantalla de inicio.</p>
<p>Esta herramienta es gratuita para todos. El
<a href="https://github.com/kamiru-art/mxm_video_converter" rel="noopener">código fuente</a>
está disponible bajo la licencia
<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" rel="noopener">CC BY-NC-SA 4.0</a>:
puedes usarlo y cambiarlo, pero no puedes venderlo. Si compartes una
versión cambiada de la herramienta, debe usar la misma licencia.</p>

</div>
<div>

<h3>② Escaneos</h3>
<p>Escanea tus hojas pintadas (o tus cianotipos secos) como quieras: a cualquier
resolución, giradas, al revés, incluso en espejo. Suelta los escaneos junto con
el archivo <code>_layout.json</code>. La app endereza cada escaneo, averigua
qué hoja es, aplana el papel que se deformó con el agua y recorta cada
fotograma. Si tu escáner tiene un ajuste de 16 bits (o de color de 48 bits), los fotogramas
conservan ese detalle de color extra.</p>
<p>Si la etiqueta de arriba a la derecha dice <strong>WebGPU</strong>, tu tarjeta
gráfica está ayudando y los escaneos van más rápido. Si dice CPU, todo sigue funcionando,
solo que más lento. En un teléfono la app hace menos a la vez: es más lenta, pero la
calidad es la misma. Si un escaneo, una hoja o un video es muy pesado para un teléfono,
te pregunta antes de empezar. En el informe, haz clic en una miniatura para verla en grande, y usa
<strong>←</strong> y <strong>→</strong> para recorrer el resto
(<strong>Esc</strong> la cierra).</p>
<p><strong>Si la app no sabe qué hoja es un escaneo.</strong> Esto
pasa cuando la pintura o la exposición cubrió los marcadores o el código QR. Esos
escaneos aparecen arriba del informe con un menú. Mira el <strong>número de
hoja impreso en la página</strong> (abajo a la derecha, a menos que lo hayas movido), o
los dibujos, y elige la hoja. La app entonces recorta sus fotogramas al
momento. Cada fila del informe tiene el mismo menú en la columna <em>Asignar</em>,
así que también puedes corregir una hoja en la que la app se equivocó.</p>
<p>El informe muestra qué fotogramas se recuperaron y cuáles faltan.</p>

<h3>③ Video</h3>
<p>La app vuelve a poner los fotogramas en su orden original. Para el sonido usa el video original. Si
recargaste la página desde que hiciste las hojas, suelta otra vez el video en
<strong>Video original (para su audio)</strong>. Luego elige cómo
guardarlo:</p>
<ul>
<li><strong>MOV sin pérdida</strong>: calidad completa, exactamente como los fotogramas
recortados. Se abre en DaVinci Resolve, Premiere, After Effects, VLC e IINA.
QuickTime Player, los teléfonos y los navegadores no pueden reproducirlo, así que usa la vista previa
de la derecha para verlo.</li>
<li><strong>Fotogramas PNG sin pérdida</strong>: los mismos fotogramas como imágenes numeradas
en un ZIP, con el sonido en un archivo aparte. Cualquier editor puede importarlo,
incluido Final Cut.</li>
<li><strong>MP4, comprimido</strong>: un archivo pequeño que se reproduce en cualquier parte, para
ver y compartir. <em>Máxima</em>, <em>Alta</em> y <em>Compacta</em> van
de más grande y nítido a más pequeño. <em>Bitrate fijo</em> te deja fijar el
tamaño tú mismo: un número más alto da un archivo más grande y más nítido. El MP4 pierde algo de
calidad, así que guarda también una copia sin pérdida.</li>
</ul>
<p>Si unos pocos fotogramas salen de otro tamaño, la app los ajusta al resto
sin estirarlos.</p>
<p>Si faltan fotogramas, el video los salta y quita su sonido, así cada
dibujo conserva el suyo. Sirve cuando duplicaste fotogramas para recortarlos y
ponerlos encima de otros. Si tu sonido ya está editado sin esos fotogramas,
desmarca <strong>Cortar también su sonido</strong> y sonará sin cortes. Puedes
soltar un archivo de sonido en lugar del video. Si desmarcas <strong>Saltar
los fotogramas que faltan</strong>, cada hueco muestra el dibujo anterior y el
video dura lo mismo que el original.</p>

<h3>Calibración (cuando necesitas precisión)</h3>
<p>Cada una de estas herramientas te da un resultado. Ponle un nombre, pulsa <strong>Guardar
perfil</strong> y luego elígelo en ① Hojas.</p>
<p><strong>Impresora</strong>: imprime la página de prueba al 100&nbsp;% y escanéala.
La app mide si tu impresora imprime un poco más grande o más pequeño de lo que
debería, y los marcadores y códigos QR más pequeños que todavía se leen bien. Elige
el resultado en ① en <strong>Perfil de impresora</strong>.</p>
<p><strong>Curva de cianotipia</strong>: imprime la carta en película, exponla,
revélala, déjala secar y escanea la copia azul. La app mide cómo responden tu
papel y tu química y hace una corrección para que los tonos salgan
parejos. Sigue el método
<a href="http://www.easydigitalnegatives.com/" rel="noopener">Easy Digital
Negatives</a>, con su carta de 256 tonos. Basta con una copia. En
<strong>Opciones avanzadas</strong> puedes promediar varias copias, o hacer
una segunda pasada para una curva más fina: elige la curva que guardaste en
<strong>Curva ya aplicada a la carta</strong>, imprime la nueva carta y
analízala igual; usa la curva que sale en lugar de la primera. Si escaneaste la película en vez de la
copia, o la carta salió casi sin diferencia entre claro y oscuro, la app te
lo dice en vez de guardar una curva mala. Elige el resultado en ① en
<strong>Curva de compensación</strong>.</p>

<h3>Consejos de cianotipia</h3>
<ul>
<li>Usa marcadores de 10 mm o más. La química desgasta los detalles pequeños.</li>
<li>Deja un margen de 6 mm o más alrededor de los marcadores. Los bordes del papel acumulan
manchas de pincel.</li>
<li>Con AHORRO DE TINTA, pon <strong>Halo entintado</strong> en 4 mm o más, para que los
marcadores queden sobre blanco limpio.</li>
<li>Escanea la copia azul cuando esté SECA y plana. Nunca escanees la película.</li>
</ul>

</div>
</div>
`;
