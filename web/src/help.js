// Help: the complete workflow, written to be used without technical knowledge.

import { el } from './ui.js';

export function mountHelp(root) {
  root.append(el('div', { class: 'prose', html: `
<h2>How it works</h2>
<ol class="steps">
  <li><span class="step-ico">🎬</span><strong>Video in</strong><span>a video or a folder of images</span></li>
  <li><span class="step-ico">🖨️</span><strong>Contact sheets</strong><span>printable, with registration markers</span></li>
  <li><span class="step-ico">✋</span><strong>Make it physical</strong><span>paint on paper, or expose cyanotypes from film negatives</span></li>
  <li><span class="step-ico">📠</span><strong>Scan</strong><span>any order, any orientation</span></li>
  <li><span class="step-ico">🤖</span><strong>Auto-process</strong><span>the app straightens, identifies and crops every frame</span></li>
  <li><span class="step-ico">🎞️</span><strong>Film out</strong><span>your animation, rebuilt</span></li>
</ol>

<h3>① Sheets</h3>
<p>Drop a video (or a folder of images). Choose how many frames per second you
want — or all of them, for frame-by-frame animation. The app detects
<strong>repeated drawings</strong> and prints them only once: when the final
video is rebuilt, that painted drawing is reused in all of its positions.</p>
<p>Keep the <strong>registration markers</strong> enabled: they are the little
squares that let each scan align itself. Every sheet carries its own
<strong>marker IDs</strong>, so the app knows which sheet a scan is even if
you scan out of order — and a single surviving marker is often enough to
identify it. With 8 markers you can paint over several of them without
trouble (3 healthy ones are enough for alignment).</p>
<p>Choose what to export: <strong>PNG</strong> per sheet, a <strong>print-ready
PDF</strong>, <strong>TIFF</strong>, or any combination — the
<code>layout.json</code> (the map used by phase ②) and a copy of the original
frames (to reprint only what fails) are always included.
<strong>Always print at 100&nbsp;%</strong>, never “fit to page”.</p>

<h3>☀️ Cyanotype mode</h3>
<p>Enable cyanotype mode to generate <strong>negatives for transparency
film</strong>: the image is inverted (and mirrored, for emulsion-to-emulsion
exposure), with your process’s compensation curve and the ink color that
blocks UV best. The <strong>INK-SAVING</strong> mode leaves the background
transparent and only inks halos around the markers: it uses a fraction of
the ink. The preview can <strong>simulate the final blue print</strong>
before you print anything.</p>
<p>The triangle next to the top-left marker is the orientation witness: on a
correct blue print it points <strong>right</strong>. If it points left, you
exposed the film flipped (the app still corrects it when scanning).</p>

<h3>② Scans</h3>
<p>Scan your painted sheets (or your dried cyanotypes) however you like: any
resolution, rotated, upside down, even mirrored. Drop the files along with
the <code>layout.json</code> and the app does the rest: it straightens using
the markers (even with several painted over), identifies each sheet by its
marker IDs (or by its QRs, on projects made with older versions), corrects
paper warped by water and crops every frame. 16-bit scans are preserved end
to end.</p>
<p>Scans are processed <strong>one at a time</strong> to keep memory low even
with huge files, and the heavy straightening step runs on your
<strong>graphics card (WebGPU)</strong> when the browser supports it.</p>
<p>The report tells you what was recovered and what is missing. One click
generates <strong>rescue sheets</strong> containing only the failed frames.</p>

<h3>③ Calibration</h3>
<p><strong>Printer</strong>: print the test page, scan it, and the app
measures whether your printer shrinks the page (and compensates for it), plus
the minimum reliable marker and QR sizes.</p>
<p><strong>Cyanotype curve</strong>: print the chart on film, expose, develop,
dry and scan the blue print. The app measures the real response of your
process and builds the curve that linearizes the tones (the
<a href="https://www.easydigitalnegatives.com/" rel="noopener">Easy Digital
Negatives</a> method built in, with a 21-patch strip or a 256-tone chart). If
you scanned the film by mistake or the chart came out flat, the app tells you
instead of saving a curve that would ruin the project.</p>
<p><strong>ColorBlocker</strong>: find out which ink color blocks UV best on
your printer (black doesn’t always win) and build a 3-stop gradient you can
apply with one click.</p>

<h3>④ Video</h3>
<p>With the processed frames, the app rebuilds the video in its original
order — reusing the deduplicated drawings — and encodes it in your browser.
Pick the <strong>format</strong> (MP4/H.264 or WebM), the
<strong>quality</strong> (or an exact bitrate) and the file name. If you
prefer editing in another program, download the individual frames.</p>

<h3>Privacy &amp; philosophy</h3>
<p>All processing happens <strong>in your browser</strong> (Rust compiled to
WebAssembly, plus WebGPU where it helps): your videos and scans never leave
your machine, there are no accounts or limits, and once loaded the page works
offline. Frames are extracted <strong>losslessly</strong> (PNG) with no color
filtering. Projects from the original desktop app (<code>layout.json</code>
v1 and v2, QRs included) are processed unchanged.</p>
<p>This tool was born from a real artist’s workflow and is released free,
forever, for everyone. If someone tries to charge you for this workflow: here
it is, with more features and
<a href="https://github.com/kamiru-art/mxm_video_converter" rel="noopener">open source</a>.</p>

<h3>Cyanotype tips (from real-world testing)</h3>
<ul>
<li>Markers ≥ 10 mm: the chemistry degrades small things.</li>
<li>Marker margin ≥ 6 mm: paper edges collect brush stains.</li>
<li>Ink-saving halos ≥ 4 mm so markers stay on guaranteed white.</li>
<li>Scan the blue print DRY and flat; never the film itself.</li>
</ul>
` }));
}
