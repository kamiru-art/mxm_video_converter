// Help: the complete workflow, written to be used without technical knowledge.

import { el } from './ui.js';

export function mountHelp(root) {
  root.append(el('div', { class: 'prose', html: `
<h2>How it works</h2>
<ol class="steps">
  <li><span class="step-num">01</span><strong>Video in</strong><span>a video or a folder of images</span></li>
  <li><span class="step-num">02</span><strong>Contact sheets</strong><span>printable, with registration markers</span></li>
  <li><span class="step-num">03</span><strong>Make it physical</strong><span>paint on paper, or expose cyanotypes from film negatives</span></li>
  <li><span class="step-num">04</span><strong>Scan</strong><span>any order, any orientation</span></li>
  <li><span class="step-num">05</span><strong>Auto-process</strong><span>the app straightens, identifies and crops every frame</span></li>
  <li><span class="step-num">06</span><strong>Film out</strong><span>your animation, rebuilt</span></li>
</ol>

<div class="cols">
<div>

<h3>① Sheets</h3>
<p>Drop a video (MP4, MOV, WebM, MKV, and also AVI, MPG, WMV or FLV through the
built-in converter) or a folder of images. Choose how many frames per second
you want, or all of them for frame-by-frame animation. If you enable
<strong>repeated-drawing detection</strong>, identical frames are printed only
once and reused in all of their positions when the video is rebuilt.</p>
<p>Keep the <strong>registration markers</strong> enabled. They are the little
squares that let each scan align itself. Every sheet carries its own
<strong>marker IDs</strong>, so the app knows which sheet a scan is even if
you scan out of order, and a single surviving marker is often enough to
identify it. With 8 markers you can paint over several of them without
trouble; 3 healthy ones are enough for alignment.</p>
<p>Marker identity distinguishes a limited number of sheets (144 with the
default settings; the preview warns you if your project exceeds it). For very
long projects, enable <strong>"Add a QR code per frame"</strong> in the
Registration section: QRs identify any number of sheets and keep
compatibility with the desktop app.</p>
<p>Choose what to export: <strong>PNG</strong> per sheet, a <strong>print-ready
PDF</strong>, <strong>TIFF</strong>, or any combination. The
<code>layout.json</code> (the map used by phase ②) and a copy of the original
frames (to reprint only what fails) are always included.
<strong>Always print at 100&nbsp;%</strong>, never "fit to page".</p>

<h3>Cyanotype mode</h3>
<p>Enable cyanotype mode to generate <strong>negatives for transparency
film</strong>: the image is inverted (and mirrored, for emulsion-to-emulsion
exposure), with your process's compensation curve and the ink color that
blocks UV best. The <strong>INK-SAVING</strong> mode leaves the background
transparent and only inks halos around the markers, so it uses a fraction of
the ink. The preview can <strong>simulate the final blue print</strong>
before you print anything.</p>
<p>The triangle next to the top-left marker is the orientation witness: on a
correct blue print it points <strong>right</strong>. If it points left, you
exposed the film flipped. The app still corrects it when scanning.</p>

<h3>Privacy &amp; philosophy</h3>
<p>All processing happens <strong>in your browser</strong> (Rust compiled to
WebAssembly, plus WebGPU where it helps): your videos and scans never leave
your machine, there are no accounts or limits, and once loaded the page works
offline. Frames are extracted <strong>losslessly</strong> (PNG) with no color
filtering. Projects from the original desktop app (<code>layout.json</code>
v1 and v2, QRs included) are processed unchanged.</p>
<p>This tool was born from a real artist's workflow and is released free,
forever, for everyone. The
<a href="https://github.com/kamiru-art/mxm_video_converter" rel="noopener">source code</a>
is available under the
<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" rel="noopener">CC BY-NC-SA 4.0</a>
license: use it and build on it, but never sell it, and whatever you make
with it must stay free under the same license.</p>

</div>
<div>

<h3>② Scans</h3>
<p>Scan your painted sheets (or your dried cyanotypes) however you like: any
resolution, rotated, upside down, even mirrored. Drop the files along with
the <code>layout.json</code> and the app does the rest: it straightens using
the markers (even with several painted over), identifies each sheet by its
marker IDs (or by its QRs, on projects that use them), corrects paper warped
by water and crops every frame. 16-bit scans are preserved end to end.</p>
<p>The app reads your machine's cores, memory and graphics card, and processes
as many scans in parallel as fit safely in memory. The heavy straightening
step runs on the <strong>graphics card (WebGPU)</strong> when the browser
supports it. In the report, click any thumbnail to see it at full size.</p>
<p>The report tells you what was recovered and what is missing. One click
generates <strong>rescue sheets</strong> containing only the failed frames.</p>

<h3>③ Video</h3>
<p>With the processed frames, the app rebuilds the video in its original
order, reusing the deduplicated drawings, and encodes it in your browser.
Pick the <strong>format</strong> (MP4/H.264 or WebM), the
<strong>quality</strong> (up to Maximum, or an exact bitrate up to
500 Mbps), the <strong>resolution</strong> (up to 8K; the panel shows the
exact output size) and the file name.</p>
<p>The <strong>Lossless</strong> quality writes every frame as PNG inside a
MOV file: pixel-identical to the processed frames, at any resolution. It
opens in editors (DaVinci Resolve, Premiere) and in VLC or IINA; QuickTime
Player and browsers no longer decode PNG video. For a master that QuickTime
plays, pick <strong>ProRes 4444</strong>: visually lossless, 10-bit,
edit-ready. The other qualities use the browser encoder, which is always
lossy. Every digital step in this app stores lossless PNG, so scan → frames
→ Lossless MOV loses nothing.</p>

<h3>Calibration (when you need precision)</h3>
<p><strong>Printer</strong>: print the test page, scan it, and the app
measures whether your printer shrinks the page (and compensates for it), plus
the minimum reliable marker and QR sizes.</p>
<p><strong>Cyanotype curve</strong>: print the chart on film, expose, develop,
dry and scan the blue print. The app measures the real response of your
process and builds the curve that linearizes the tones, using the
<a href="https://www.easydigitalnegatives.com/" rel="noopener">Easy Digital
Negatives</a> method with a 21-patch strip or a 256-tone chart. If you
scanned the film by mistake or the chart came out flat, the app tells you
instead of saving a curve that would ruin the project.</p>
<p><strong>ColorBlocker</strong>: find out which ink color blocks UV best on
your printer (it is not always black) and build a 3-stop gradient you can
apply with one click.</p>

<h3>Cyanotype tips (from real-world testing)</h3>
<ul>
<li>Markers of 10 mm or more: the chemistry degrades small things.</li>
<li>Marker margin of 6 mm or more: paper edges collect brush stains.</li>
<li>Ink-saving halos of 4 mm or more, so markers stay on guaranteed white.</li>
<li>Scan the blue print DRY and flat; never the film itself.</li>
</ul>

</div>
</div>
` }));
}
