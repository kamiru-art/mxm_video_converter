# MXM Studio

MXM Studio is a free tool for mixed-media animation and for cyanotype prints.
The tool runs fully in your web browser. Your videos and your scans stay on
your computer, because the application does not send them to a server.

Use the application here: <https://mxm.sebastianlopez.me>

You do not need an account, and you do not need to install software.

## The workflow

```
video (or a folder of images)
  -> printable contact sheets, with registration markers
     -> paint on the paper, or expose cyanotypes from transparent sheets
        -> scan the sheets (in any sequence and in any orientation)
           -> the application aligns, identifies and cuts out each frame
              -> the new video
```

The application has three phases:

| Phase | Function |
|---|---|
| 1. Sheets | The application makes printable contact sheets from a video or from a folder of images. |
| 2. Scans | The application reads your scanned sheets and cuts out each frame. |
| 3. Video | The application makes the new video from the frames. |

Two more pages are available: Calibration and Help.

Between phase 1 and phase 2, you do the manual work:

1. Print the contact sheets.
2. Paint or draw on the paper. For a cyanotype, print the negative on a
   transparent sheet. Then expose the coated paper to the sun.
3. Scan the sheets. The sequence and the orientation are not important.

## Functions

### Contact sheets

- You can set the grid, the paper size and the resolution in dots per inch.
- The application selects the page orientation that fits best.
- You can add labels and a sheet number.
- You can select which frames and which sheets to print.
- The application finds the drawings that are identical. It prints each
  repeated frame one time only, and it uses that frame again for the video.
- You can write the sheets as PNG, as TIFF, or as a PDF that is ready to
  print.
- You can keep a group of settings as a named preset.

### Registration markers

- Each sheet has 4, 8 or 12 redundant ArUco markers. The application
  identifies each sheet by the marker IDs.
- You can also put one QR code on each frame. This is not the default. Use it
  for a project with many sheets.
- The application aligns and identifies a scanned sheet without your help.
  This is also true when the sheet is rotated, upside down or mirrored, and
  when there is paint on some of the markers.
- You can add a strip of gray patches. The application uses the strip to
  correct the levels of the scan.

### Cyanotype mode

- The application makes negatives for transparent sheets.
- You can apply a compensation curve. The Easy Digital Negatives method is
  included.
- You can select one ink color, or a gradient with three ink stops.
- An ink-economy mode prints halos in the place of solid areas.
- The application can also add a blocker border, mirror the image, and show a
  preview of the blue print.

### Scan processing

- The application calculates a RANSAC homography to align each scan.
- You can set how many markers a scan must show before the application
  accepts it.
- If the browser has WebGPU, the application straightens the scans on the
  graphics card. If not, it uses WebAssembly.
- A local correction adjusts paper that is deformed.
- The application finds the scale of the scan automatically.
- If the application does not find sufficient markers, it lets you point at
  them.
- The full sequence keeps 16 bits for each color channel.
- The application makes a report with thumbnails.
- The application makes rescue sheets. A rescue sheet contains only the
  frames that failed, thus you print again only what is necessary.

### Manual sheet assignment

Sometimes the markers align correctly but the QR code is not readable,
because there is paint on the code or because the exposure was bad. In this
condition, you tell the application which sheet it is. The application then
processes that scan again, with the correct labels.

### Example project

One button makes an animation of six frames. Phase 2 can then simulate the
scans of the sheets of that animation. Thus you can do the full workflow
without your own files and without a printer.

### Calibration

- Printer profile: the true scale, the tonal response and the minimum sizes.
- Cyanotype curve: from a strip of 21 patches, or from an EDN chart of 256
  tones.
- ColorBlocker: the ink color that blocks ultraviolet light best on your
  printer.

### The new video

The application makes the video in your browser. It keeps the original
sequence of the frames and the repeated frames. These output formats are
available:

- MP4, with the AVC codec
- WebM, with the VP9, AV1 or VP8 codec
- MOV, with one PNG image for each frame, for a result without losses
- MOV, with the ProRes 4444 codec, for video editors

The application reads MP4, WebM, AVI and MOV files. It decodes them with
WebCodecs. If the browser cannot decode a file, the application uses
`ffmpeg.wasm`. Thus the application also reads the MOV files of cameras, for
example 10-bit HEVC and ProRes.

## Structure

| Directory | Contents |
|---|---|
| `rust-core/` | The image processing core. It is written in Rust and compiled to WebAssembly. It makes the sheets, it makes and finds the ArUco markers, it reads the QR codes, and it does the homography, the warp, the cyanotype curves, the calibration and the PDF output. |
| `web/` | The web application, in HTML, JavaScript and CSS. It uses no framework. The video work uses WebCodecs. The browser does all of the work, in web workers. |
| `assets/` | The icons of the application. |

There is no server. The site is fully static, and it is on Cloudflare Workers
with static assets. The site is a Progressive Web Application: it has a
manifest and a service worker. Thus you can install it as an application, and
it also works offline after the first load.

Your browser keeps the presets, the calibration profiles and your last sheet
settings. You can export this data as JSON, and you can import it again. The
project itself stays in memory: if you reload the page, you must load your
files again.

The application also reads the `layout.json` files of the older desktop
versions, thus your old projects still work.

## Development

You need these tools:

- Rust, with the `wasm32-unknown-unknown` target
- `wasm-pack`
- Node.js 22 or later
- Google Chrome and `ffmpeg`, for the end-to-end test only

Then use these commands:

```bash
cd rust-core
cargo test                              # tests of the core (native and fast)
wasm-pack build --release --target web --out-dir ../web/src/wasm

cd ../web
npm install
npm run dev                             # development server
npm run test:e2e                        # end-to-end test in Chrome
npm run build                           # production build, into web/dist
npx wrangler@4 deploy                   # publish the site
```

`npm run dev` does not make the `ffmpeg.wasm` files. Only `npm run build` and
`npm run test:e2e` make them. Thus the AVI files and the camera MOV files do
not open in the development server until you do one of those two commands one
time.

The CI workflow does the same tests for each push and for each pull request.
When the tests pass on the `main` branch, the workflow publishes the site.

## License

Source code: <https://github.com/kamiru-art/mxm_video_converter>

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). You
can use this work, adapt it and give it to other persons. You cannot sell it,
and you cannot make money from it. All work that you build on it must stay
free and must keep the same license. Refer to [LICENSE](LICENSE).

The core embeds the DejaVu Sans font. That font has its own license. Refer to
[rust-core/assets/DejaVuSans-LICENSE.txt](rust-core/assets/DejaVuSans-LICENSE.txt).
