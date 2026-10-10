// Help: the complete workflow, written to be used without technical knowledge.

import { el } from './ui.ts';

export function mountHelp(root: HTMLElement): void {
  root.append(
    el('div', {
      class: 'prose',
      html: `
<h2>How it works</h2>
<ol class="steps">
  <li><span class="step-num">01</span><strong>Video in</strong><span>a video or a folder of images</span></li>
  <li><span class="step-num">02</span><strong>Contact sheets</strong><span>printable, with registration markers</span></li>
  <li><span class="step-num">03</span><strong>Paint or expose</strong><span>paint on paper, or expose cyanotypes from film negatives</span></li>
  <li><span class="step-num">04</span><strong>Scan</strong><span>any order, any orientation</span></li>
  <li><span class="step-num">05</span><strong>Auto-process</strong><span>the app straightens, identifies and crops every frame</span></li>
  <li><span class="step-num">06</span><strong>Video</strong><span>your frames back together as a video</span></li>
</ol>

<div class="cols">
<div>

<h3>① Sheets</h3>
<p>To try the app without your own files, press <strong>&ldquo;Try it with a
6-frame example&rdquo;</strong>. It makes a short animation. Generate the
sheets, then in ② press <strong>&ldquo;Simulate them from this session&rsquo;s
sheets&rdquo;</strong> to get fake scans of them.</p>
<p>Drop a video or a folder of images. Choose how many frames per second you
want, or all of them for frame-by-frame animation. If you turn on
<strong>Detect repeated drawings</strong>, identical frames are printed only
once and used again wherever they appear in the video.</p>
<p>Videos from some cameras carry extra colour detail. The app keeps it, but
in some browsers that makes loading slow. If it is too slow, turn on
<strong>Fast 8-bit decode</strong>: it is faster, with slightly less colour
detail.</p>
<p>Keep the <strong>registration markers</strong> on. They are the small
squares around the edges of the sheet. The app uses them to straighten each
scan and to know which sheet it is, so you can scan in any order. With 8
markers you can paint over some of them: the app needs at least 3 clean ones
to straighten the scan.</p>
<p>The markers can tell apart up to 144 sheets with the default settings, and
the preview warns you if you go over. For longer projects, turn on
<strong>&ldquo;Add a QR code per frame&rdquo;</strong> in the Registration
section.</p>
<p>You can export the sheets as <strong>PNG</strong>, <strong>PDF</strong>
(ready to print), <strong>TIFF</strong>, or several at once. The download
always includes a file ending in <code>_layout.json</code>, which you will
need in ②. Leave <strong>Include the frames as image files</strong> on: you
need that copy of the frames to make rescue sheets later.
<strong>Always print at 100&nbsp;%</strong>, never &ldquo;fit to page&rdquo;.</p>

<h3>Cyanotype mode</h3>
<p>Cyanotype mode makes <strong>negatives to print on transparency
film</strong>. The image is inverted and mirrored. If you calibrated (see
Calibration), it is printed in your best UV-blocking ink and adjusted with
your cyanotype curve. <strong>INK-SAVING</strong> mode leaves the background
clear and only prints a border of ink around each marker, so it uses much
less ink. Turn on <strong>Simulate final blue print</strong> to see in the
preview what the blue print will look like.</p>
<p>The small triangle next to the top-left marker tells you which way the
print came out. On a correct blue print it points <strong>right</strong>. If
it points left, the film was flipped when you exposed it. The app fixes this
on its own when it reads the scan.</p>

<h3>Privacy</h3>
<p>Everything happens <strong>in your browser</strong>. Your videos and scans
never leave your computer. There are no accounts and no limits, and once the
page has loaded it also works offline. You can <strong>install it</strong> as
an app: in Chrome and Edge, use the install icon in the address bar; on iPhone
and iPad, Share → Add to Home Screen.</p>
<p>This tool is free for everyone. The
<a href="https://github.com/kamiru-art/mxm_video_converter" rel="noopener">source code</a>
is available under the
<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" rel="noopener">CC BY-NC-SA 4.0</a>
license: you can use it and change it, but you cannot sell it. If you share a
changed version of the tool, it must use the same license.</p>

</div>
<div>

<h3>② Scans</h3>
<p>Scan your painted sheets (or your dry cyanotypes) any way you like: any
resolution, rotated, upside down, even mirrored. Drop the scans together with
the <code>_layout.json</code> file. The app straightens each scan, works out
which sheet it is, flattens paper that warped from water, and cuts out every
frame. If your scanner has a 16-bit (or 48-bit colour) setting, the frames
keep that extra colour detail.</p>
<p>If the label at the top right says <strong>WebGPU</strong>, your graphics
card is helping and scans go faster. If it says CPU, everything still works,
just slower. In the report, click a thumbnail to see it large, and use
<strong>←</strong> and <strong>→</strong> to go through the rest
(<strong>Esc</strong> closes it).</p>
<p><strong>If the app can&rsquo;t tell which sheet a scan is.</strong> This
happens when paint or the exposure covered the markers or the QR code. Those
scans appear at the top of the report with a menu. Look at the <strong>sheet
number printed on the page</strong> (bottom right, unless you moved it), or
at the drawings, and pick the sheet. The app then cuts out its frames right
away. Every row of the report has the same menu in the <em>Assign</em>
column, so you can also fix a sheet the app got wrong.</p>
<p>The report shows which frames were recovered and which are missing. To
paint the missing ones again, drop the frames folder that came with your
sheets download under <strong>Rescue sheets</strong> and press
<strong>Generate rescue sheets</strong>. You get new sheets with only those
frames.</p>

<h3>③ Video</h3>
<p>The app puts the frames back in their original order, with repeated
drawings in all their places. For the sound it uses the original video. If
you reloaded the page since making the sheets, drop the video again into
<strong>Original video (for its audio)</strong>. Then choose how to save
it:</p>
<ul>
<li><strong>Lossless MOV</strong>: full quality, exactly like the cut-out
frames. It opens in DaVinci Resolve, Premiere, After Effects, VLC and IINA.
QuickTime Player, phones and browsers can&rsquo;t play it, so use the preview
on the right to watch it.</li>
<li><strong>Lossless PNG frames</strong>: the same frames as numbered images
in a ZIP, with the sound as a separate file. Any editor can import it,
including Final Cut.</li>
<li><strong>MP4, compressed</strong>: a small file that plays anywhere, for
watching and sharing. <em>Best</em>, <em>High</em> and <em>Compact</em> go
from larger and sharper to smaller. <em>Fixed bitrate</em> lets you set the
size yourself: a higher number gives a bigger, sharper file. MP4 loses some
quality, so keep a lossless copy too.</li>
</ul>
<p>If a few frames come out a different size, the app fits them to the rest
without stretching them.</p>

<h3>Calibration (when you need precision)</h3>
<p>Each of these tools gives you a result. Give it a name, press <strong>Save
profile</strong>, and then pick it in ① Sheets.</p>
<p><strong>Printer</strong>: print the test page at 100&nbsp;% and scan it.
The app measures whether your printer prints a little bigger or smaller than
it should, and the smallest markers and QR codes that still read well. Pick
the result in ① under <strong>Printer profile</strong>.</p>
<p><strong>Cyanotype curve</strong>: print the chart on film, expose it,
develop it, let it dry and scan the blue print. The app measures how your
paper and chemistry respond and makes a correction so the tones come out
even. It follows the
<a href="https://www.easydigitalnegatives.com/" rel="noopener">Easy Digital
Negatives</a> method, with a 21-patch strip or a 256-tone chart. If you
scanned the film instead of the print, or the chart came out with almost no
difference between light and dark, the app tells you instead of saving a bad
curve. Pick the result in ① under <strong>Compensation curve</strong>.</p>
<p><strong>ColorBlocker</strong>: finds which ink colour blocks UV light best
on your printer (it is not always black) and makes a gradient from it. Pick
the result in ① under <strong>Ink color profile</strong>, so your negatives
print in that colour.</p>

<h3>Cyanotype tips</h3>
<ul>
<li>Use markers of 10 mm or more. The chemistry wears away small details.</li>
<li>Leave a margin of 6 mm or more around the markers. Paper edges collect
brush stains.</li>
<li>With INK-SAVING, set <strong>Inked halo</strong> to 4 mm or more, so the
markers sit on clean white.</li>
<li>Scan the blue print when it is DRY and flat. Never scan the film.</li>
</ul>

</div>
</div>
`,
    }),
  );
}
