// Ayuda: el flujo completo, explicado para usarse sin conocimientos técnicos.

import { el } from './ui.js';

export function mountHelp(root) {
  root.append(el('div', { class: 'prose', html: `
<h2>Cómo funciona</h2>
<div class="flow">🎬 video (o carpeta de imágenes)
   → 🖨️ hojas de contacto imprimibles (con marcadores de registro)
      → ✋ pintar sobre el papel  /  ☀️ exponer cianotipias desde acetatos
         → 📠 escanear todo (en cualquier orden y orientación)
            → 🤖 la app endereza, identifica y recorta cada fotograma sola
               → 🎬 video final reconstruido</div>

<h3>① Hojas</h3>
<p>Suelta un video (o una carpeta de imágenes). Elige cuántos fotogramas por
segundo quieres — o todos, para animación cuadro a cuadro. La app detecta los
<strong>dibujos repetidos</strong> y los imprime una sola vez: al armar el
video final, ese dibujo pintado se reutiliza en todas sus posiciones.</p>
<p>Deja activados los <strong>marcadores de registro</strong>: son los
cuadraditos que permiten que el escaneo se alinee e identifique solo. Con 8
marcadores puedes pintar encima de varios sin problema (bastan 3 sanos), y
cada fotograma lleva un <strong>QR</strong> con su identidad — un solo QR
legible identifica la hoja completa aunque escanees desordenado.</p>
<p>El ZIP que descargas trae los PNG de cada hoja, un <strong>PDF listo para
imprimir</strong>, el <code>layout.json</code> (el mapa que usa la fase ②) y
una copia de los fotogramas originales (para reimprimir solo lo que falle).
<strong>Imprime siempre al 100&nbsp;%</strong>, sin «ajustar a página».</p>

<h3>☀️ Modo cianotipia</h3>
<p>Activa el modo cianotipia para generar <strong>negativos para
acetato</strong>: la imagen va invertida (y espejada, para exponer
emulsión-contra-emulsión), con la curva de compensación de tu proceso y el
color de tinta que mejor bloquee el UV. El modo <strong>AHORRO</strong> deja
el fondo transparente y solo entinta halos alrededor de marcadores y QRs:
gasta una fracción de la tinta. La vista previa puede <strong>simular la
copia azul final</strong> antes de imprimir nada.</p>
<p>El triángulo junto al marcador de arriba-izquierda es el testigo de
orientación: en la copia azul correcta apunta a la <strong>derecha</strong>.
Si apunta a la izquierda, expusiste el acetato al revés (la app igual lo
corrige al escanear).</p>

<h3>② Escaneos</h3>
<p>Escanea tus hojas pintadas (o tus cianotipias secas) como quieras:
cualquier resolución, rotadas, de cabeza, incluso en espejo. Suelta los
archivos junto al <code>layout.json</code> y la app hace el resto: endereza
con los marcadores (aunque varios estén pintados), identifica cada hoja por
sus QR, corrige el papel deformado por el agua y recorta cada fotograma. Los
escaneos de 16 bits se conservan de punta a punta.</p>
<p>El informe te dice qué se recuperó y qué falta. Con un clic generas
<strong>hojas de rescate</strong> que contienen solo los fotogramas fallidos.</p>

<h3>③ Calibración</h3>
<p><strong>Impresora</strong>: imprime la página de prueba, escanéala y la app
mide si tu impresora encoge la página (y lo compensa), además del tamaño
mínimo fiable de marcador y QR.</p>
<p><strong>Curva de cianotipia</strong>: imprime la carta en acetato, expón,
revela, seca y escanea la copia azul. La app mide la respuesta real de tu
proceso y construye la curva que lineariza los tonos (método
<a href="https://www.easydigitalnegatives.com/" rel="noopener">Easy Digital
Negatives</a> integrado, con carta de 21 parches o de 256 tonos). Si
escaneaste el acetato por error o la carta salió plana, la app te lo dice en
vez de guardar una curva que arruinaría el proyecto.</p>
<p><strong>ColorBlocker</strong>: descubre qué color de tinta bloquea mejor el
UV en tu impresora (el negro no siempre gana) y construye un degradado de 3
paradas aplicable con un clic.</p>

<h3>④ Video</h3>
<p>Con los fotogramas procesados, la app reconstruye el video en su orden
original — reutilizando los dibujos deduplicados — y lo codifica en tu
navegador (MP4 H.264 o WebM). Si prefieres editar en otro programa, descarga
los fotogramas sueltos.</p>

<h3>Privacidad y filosofía</h3>
<p>Todo el procesamiento ocurre <strong>en tu navegador</strong> (Rust
compilado a WebAssembly): tus videos y escaneos no salen de tu máquina, no
hay cuentas ni límites, y una vez cargada la página funciona sin conexión.
Los fotogramas se extraen <strong>sin pérdida</strong> (PNG) y sin ningún
filtro de color. Los proyectos de la app de escritorio original
(<code>layout.json</code> v1 y v2) se procesan sin cambios.</p>
<p>Esta herramienta nació para el flujo real de una artista y se libera
gratis, para siempre, para todo el mundo. Si alguien intenta cobrarte por
este flujo: aquí lo tienes, con más funciones y con el
<a href="https://github.com/kamiru-art/mxm_video_converter" rel="noopener">código abierto</a>.</p>

<h3>Consejos de cianotipia (de las pruebas reales)</h3>
<ul>
<li>Marcadores ≥ 10 mm y QRs ≥ 12 mm: la química degrada lo pequeño.</li>
<li>Margen de marcadores ≥ 6 mm: los bordes acumulan manchas de brocha.</li>
<li>Halos de ahorro ≥ 4 mm para que los marcadores queden sobre blanco.</li>
<li>Escanea la copia azul SECA y plana; nunca el acetato.</li>
</ul>
` }));
}
