# Architecture

## 1) Architectural Style

- Primary style: a layered client application, organised by workflow phase,
  with a worker pool in front of a WebAssembly core.
- Why this classification: `web/src/main.ts` mounts one module for each phase
  and holds no domain logic; every phase reaches the core only through
  `run()` in `web/src/pool.ts`; and `rust-core/src/api.rs` is the single door
  into the Rust modules, which import no browser type.
- Primary constraints that shape the design:
  1. There is no server. Nothing can be moved off the user's machine, so all
     cost is local and memory is the scarce resource.
  2. WebAssembly memory never shrinks. This one fact produced the recycling
     pool described below.
  3. The browser must stay responsive, so the heavy work has to leave the main
     thread.

## 2) System Flow

```text
index.html
  -> main.ts            picks the phase from location.hash and mounts it
  -> phaseN.ts          builds the DOM, reads the user's files
  -> pool.ts  run(cmd)  picks a worker, sends the command, returns a promise
  -> worker.ts          looks the command up in its table
  -> api.rs             validates, converts JSON to typed values
  -> domain modules     sheet / scanproc / cyanotype / aruco / qr / calib
  -> back through the same path, with the pixel buffers transferred
```

Six steps, with evidence:

1. `web/src/main.ts` resolves the route and calls the matching `mount*`
   function one time only, then dispatches an `mxm:activated` event.
2. The phase module reads files through `web/src/project.ts`, which holds the
   shared state in memory.
3. `web/src/pool.ts` sends the command. It keeps commands with state on
   worker 0 (`pinned`), because a PDF is built across several calls.
4. `web/src/worker.ts` maps the command name to a core function and marks the
   worker `poisoned` if the core panics.
5. `rust-core/src/api.rs` converts and validates, then calls the domain
   module.
6. The result travels back as JSON plus transferred `ArrayBuffer` values, so
   the pixels are moved and not copied (`web/src/worker.ts`, the `transfer`
   arrays).

The video decoders are separate and do not use the core: `web/src/video.ts`
uses WebCodecs through `mediabunny`, and falls back to `ffmpeg.wasm`
(`web/src/avi.ts`) when the browser refuses a file. Both hand every decoded
frame to `web/src/frames.ts`, which sends it through the same pool to an
`encode_frame` command: the worker makes the thumbnail (and the PNG, when
one is wanted), several frames at a time, and the queue delivers them to the
phase in order.

**The video is the source of truth.** A frame that WebCodecs can decode is
not stored at all: `ProjectFrame` (`web/src/project.ts`) keeps `video:
{file, t}` and a 256 px thumbnail, and the frame is decoded again from the
file whenever its pixels are needed: a page of sheets at a time
(`prefetchVideoFrames`, one pass in time order), the preview
(`prefetchPreviews`), the lightbox, and the ZIP export (`framePngs`, which
encodes the PNGs only then, pipelined through the pool). A 4K frame is 10 MB
as PNG, so a project of a few hundred frames used to hold gigabytes of Blobs
that added nothing: the sheet only needs each frame at cell size, resampled
once with Lanczos from the decoded frame. Frames that come from
`ffmpeg.wasm` cannot be re-decoded quickly (minutes per pass), so those keep
their PNG, written to the browser's private file system (`web/src/opfs.ts`,
OPFS) and held as file-backed Blobs; without OPFS they stay in memory as
before. Image folders, TIFF and the demo frames are files already and are
untouched.

OPFS belongs to the origin, not to the tab. Each tab writes under
`tabs/<id>/` (frames, scan crops, export frames, outputs) and clears only
its own folder. A tab takes a Web Lock named after its id when it first
writes and holds it for as long as it lives, and it touches its `alive`
file every five minutes (timers stop in the back/forward cache). A tab that
really unloads (`pagehide` with `persisted` false: closed or reloaded)
leaves a mark in `localStorage`. `sweepStorage` runs at start-up and with
every heartbeat; it empties a folder only when it is marked closed or its
`alive` is more than an hour old, AND its lock is free, probed with
`ifAvailable` and kept while it deletes; outputs younger than ten minutes,
which a download may still read, stay. The hour protects pages in the
back/forward cache: Safari 26 drops their locks, and querying a lock held
by a cached page makes Chrome 146+ evict it (`WebLocksContention`, measured
in Chrome 155), so nothing calls `navigator.locks.query()`. A page back
from the cache takes its lock again (`ifAvailable`). Each cache lives in
one folder per generation (`processed-0`, `processed-1`…): clearing moves
on to the next one, and the old one is deleted once no `holdFrames` pins
it. An export or the scans ZIP pins every generation from the one it
started with; when an export ends, its hold is narrowed to those
generations and passed to the in-page preview until the next one.
The shared folders of older versions are emptied after a day. Until
2026-10 the folders were shared: opening the app in another tab at
`#scans` (or "Clear results" there) deleted the first tab's crops, and its
ZIP failed with `NotFoundError` (Chrome, Opera, Safari) or `AbortError`
(Firefox).

## 3) Layer/Module Responsibilities

| Layer or module | Owns | Must not own | Evidence |
|-----------------|------|--------------|----------|
| `main.ts` | Routing, mounting, the capability badge. | Domain work. | `web/src/main.ts` |
| `phase1..4.ts`, `help.ts` | The DOM of one phase, its events, its progress reporting. | WebAssembly calls, persistence format. | `web/src/phase2.ts` |
| `pool.ts` | How many workers exist, which one runs what, when one is recycled. | The meaning of a command. | `web/src/pool.ts` |
| `worker.ts` | The command table and the transfer lists. | Validation, algorithms. | `web/src/worker.ts` |
| `project.ts` | The state shared between phases, in memory. | Writing to disk or to `localStorage`. | `web/src/project.ts` |
| `store.ts` | The single `localStorage` key `mxm-studio-v1`. | Domain rules. | `web/src/store.ts` |
| `api.rs` | Argument validation, JSON, the error strings the user sees. | Image algorithms. | `rust-core/src/api.rs` |
| Rust domain modules | Pixels and geometry, as plain Rust. | Anything about the browser. | `rust-core/src/sheet.rs` |

## 4) Reused Patterns

| Pattern | Where found | Why it exists |
|---------|-------------|---------------|
| Worker pool with recycling | `web/src/pool.ts` | WebAssembly memory never shrinks. After a large scan the only way to return the memory is to terminate the worker and start another. The pool recycles above 700 MB, and only when the worker is idle. |
| Worker affinity | `web/src/pool.ts` (`pinned`) | A PDF is built over several calls, so its state must stay in one worker. |
| Streaming PDF | `rust-core/src/pdf.rs`, `web/src/gen.ts` (`pdfParts`) | `pdf_add` returns the bytes of that page and the core keeps only the xref offsets; the page's image is the sheet PNG's own IDAT stream, declared with the PNG predictor, so nothing is decoded or recompressed. The file is the concatenation of the chunks, held as Blobs. The previous writer kept every page compressed in the worker and copied them twice at the end: at 8.5 MB per A4 page at 300 dpi it aborted at page 249 with `unreachable`, after the user had waited 25 minutes; the new one wrote 600 pages (4 GB) in 3 s. |
| Poison flag | `web/src/worker.ts` and `web/src/pool.ts` | A Rust panic leaves the WebAssembly instance unusable, so the worker is marked and replaced when it goes idle. |
| Lazy respawn after a failure | `web/src/pool.ts` (`fail`, `MAX_BOOT_FAILURES`) | A worker that never replied did not start, usually because the tab is older than the deployed site and its hashed `worker-*.js` no longer exists. Respawning from `onerror` was a loop with no pause: one request to the origin per turn, and nothing visible to the user. Now the slot stays empty until the next `run()`, with a cap on attempts. |
| Command table | `web/src/worker.ts` (`handlers`) | One flat map from a command name to a core function. |
| Module-level singleton | `web/src/project.ts` | One shared project object, imported by every phase. |
| Adapter over storage | `web/src/store.ts` | Every read and write of `localStorage` is wrapped in `try`/`catch` in one place. |
| Explicit buffer transfer | `web/src/worker.ts` | Pixel buffers are moved between threads instead of copied. |
| Ordered encode queue | `web/src/frames.ts` (`FrameQueue`) | Encoding a 4K frame to PNG costs about 160 ms, and it used to run on the main thread one frame at a time while the hardware decoder waited. The queue sends each frame to a pool worker as an `ImageBitmap` or raw RGBA, keeps at most one job per worker plus one in flight, and emits the results in order, so the frame index is stable and the memory is bounded. Measured on a 4K HEVC clip of 56 s at 4 fps: 36 s before, 11 s after, with byte-identical PNGs. |
| Streaming ZIP on disk | `web/src/zip.ts` (`ZipSink`), `web/src/zipwriter.ts`, `web/src/opfs.ts` (`openOutput`) | The ZIP format is written by `zipwriter.ts`, ZIP64 on every entry (fflate wrote 32-bit sizes and offsets, so anything over 4 GB came out silently corrupt); validated with Python's `zipfile` and `unzip -t` on a 4.5 GB archive. The ZIP is written entry by entry, as each sheet is produced, into a file of the browser's private file system (OPFS); the PDF chunks go to another. A Blob read from there is served by the disk, so a project of many GB never lives in the tab's memory nor in the browser's Blob store (Chrome's depends on the free space of the system disk and failed at 0.7 GB on a full machine). Without OPFS the same code keeps Blob parts in memory, as before. The File System Access API was deliberately not used: it does not exist on phones or in most browsers, and the site must run almost everywhere. |
| Multithreaded ffmpeg with fallback | `web/src/avi.ts` (`ffmpegThreads`), `web/public/_headers`, `web/prepare-ffmpeg.mts` | `public/ffmpeg/mt` is `@ffmpeg/core-mt`, used when the page is cross-origin isolated (COOP + COEP headers, sent by Cloudflare, the dev server and the E2E server alike, so a header that breaks the site fails the test). The choice is made by a runtime probe, not by browser name: a throwaway multithreaded instance decodes an embedded 6-frame H.264 clip with the thread count that will be used, under an 8 s timeout, and the first decoded frame is verified; only then does the session load a fresh multithreaded instance. Chrome loads the core and runs `-version`, but stalls forever as soon as a decoder uses four threads or an encoder two (measured with and without a window), so the probe sends Chrome to `public/ffmpeg/st`, the single-threaded core of before; Firefox passes and runs eight. Measured in Zen on 8 s of a 4K HEVC clip: 34.5 s single-threaded, 9.4 s with threads. |
| Lazy ZIP entries | `web/src/zip.ts` (`ZipEntryData` as a function) | The `_originals/` and `_frames/` copies of a video frame are produced when the ZIP reaches them, not before, so exporting costs one PNG per frame at pack time and nothing when the export is off. |
| Cancellation by `AbortSignal` | `web/src/video.ts`, `web/src/avi.ts`, `web/src/gen.ts`, `web/src/errors.ts` (`CancelledError`), `web/src/ui.ts` (`cancelButton`, `lockControls`) | Every long task takes a `signal`: the two extractors, sheet generation (checked as each sheet is collected and between frame files), the lossless export (between conformed drawings and written frames), and the scan batch (no more scans are taken from the queue; the ones already inside a worker finish, because the core cannot be interrupted). WebCodecs checks the signal between frames; `ffmpeg.wasm` cannot be interrupted inside `exec`, so the abort terminates the instance and the rejected call is read as the stop, not as a failure. A stop surfaces as `CancelledError` (`isCancelled`), which the phases announce as a stop, never as a failure; a half-written ZIP is discarded. While a task runs, `lockControls` disables every control of its panel except the Cancel button, because changing a format or dropping another file mid-way never affected the running task but the interface suggested it did. |
| Lossless final video, planned per sequence | `web/src/export.ts` (`planSequence`, `exportLossless`), `web/src/imageinfo.ts`, `rust-core/src/conform.rs`, `web/src/pngmov.ts` | There is no quality to choose: the output is PNG inside a MOV, or numbered PNGs in a ZIP with a WAV. The plan reads only headers: the size is the one most positions have, the depth is 16 bits if any drawing has more than 8 (8-bit ones are widened, v · 257, exactly), alpha if any drawing has it. A PNG that already matches is copied byte for byte; the rest is conformed by the core in the pool, as many at a time as a quarter of `navigator.deviceMemory` allows, and written to OPFS. A size difference up to 1 % or 4 px is centred, not resampled; only a really different size is fitted with Lanczos3. The lossy copy is a separate path (next row). Phones and browsers cannot play PNG video, so `web/src/player.ts` shows the same frames at the same fps on a canvas, with the original playing underneath as the clock. |
| Compressed MP4 from the same plan | `web/src/lossy.ts` (`exportCompressed`, `FrameQueue`, `encodeSize`) | For watching and sharing; the lossless file stays the master. Three presets (Best, High, Compact) are variable bitrate targets that grow with the pixel count (about 41, 22 and 6 Mbps at 1080p in H.264), plus a fixed bitrate. Presets never use mediabunny's constant-quantizer mode: Firefox accepts it and ignores the QP, so all three came out identical. H.264 first, then H.265, VP9, AV1, all in MP4; with a fixed bitrate each codec tries constant then average before the next codec. The browser decodes the PNGs (any depth, no colour management) ahead of the encoder, and a repeated drawing stays decoded until its last use, evicting the one needed furthest ahead; the core conforms only TIFFs and off-size frames. The width is padded to a multiple of 4 and the height to even, in white, without resampling (Chrome shifts a 4k + 2 width by a pixel). The encoder's `fullRange` claim is overridden to limited, which is what all three browsers write from a canvas (Safari claimed full). Sound is the same decoded PCM as the lossless path, fed as 1 s copies (mediabunny 1.55 drops a view's offset), AAC or Opus. Written to OPFS in 16 MB chunks with the moov reserved at the start. |
| Original audio in the final video | `web/src/export.ts` (`AudioFrom`, `pcmForExport`, `decodePcm`, `mixInto`), `web/src/phase4.ts`, `web/src/types.ts` (`VideoMeta.inicio_s`) | The frames are a stretch of the source at N fps, so the sound of that same stretch, cut to the length of the sequence and re-timed from zero, lines up with the frames by construction. Phase ① writes the start of the extracted range into the layout (`video.inicio_s`); phase ④ reads it, reuses the phase ① video when it is still the same project, or takes the clip dropped there. The browser decodes the track (mediabunny over WebCodecs) to 16-bit PCM, more than two channels folded to stereo keeping the centre, and it goes into the MOV as `sowt` or into the ZIP as a WAV. A source without an audio track, or a start past its end, yields a silent video and a toast, never an error. |
| Crops of one size | `rust-core/src/scanproc.rs` (`crop_frame`), `rust-core/src/img.rs` (`DynImg::crop_fixed`) | The crop size comes from the size of the frame's box alone and its corner is rounded separately, so every frame of one size in the layout is cut to the same pixels, padded with white if it runs off the straightened sheet. Rounding both edges independently gave crops 1–2 px apart, and the final video had to resample all of them. |
| One quantization, at the end | `rust-core/src/photo.rs`, `rust-core/src/sheet.rs` (`render_page`, `finish_page16`), `rust-core/src/pdf.rs` | A frame goes from its file to its cell in f32: alpha composed in the first resampling pass (8- or 16-bit RGBA in), Lanczos3, grey and clarity, the cyanotype curve and the ink ramp both interpolated. The 8-bit sheet dithers in density before picking a colour of the 256-ink ramp. If any printed frame is 16-bit (`Settings::deep`, set by `gen.ts`) the sheet is also produced in 16 bits: the 8-bit canvas widened with the 16-bit frames placed over it, and that is the PNG, the TIFF and the PDF page (`/BitsPerComponent 16`, PDF 1.5). |
| Sheets rendered several at a time | `web/src/gen.ts` (`pagesInFlight`, `collect`) | While a sheet renders in one worker the next is decoded and sent to another; the PDF page, the TIFF and the ZIP entries are still written in order as each sheet is collected. The number in flight is the pool size, bounded by a third of `navigator.deviceMemory` against each sheet's full-resolution frames. A stop is checked at every collection. |
| Content-addressed ffmpeg core | `web/prepare-ffmpeg.mts`, `web/src/avi.ts` (`coreManifest`), `web/src/sw.ts` | The core's parts live in `/ffmpeg/<st|mt>-<hash>/`, which never changes, so the service worker keeps them cache-first and cannot join parts of two versions; the small `manifest.json` that names the directory goes network-first. |
| Network-first document, cache-first assets | `web/src/sw.ts` | Vite hashes the asset names on each build, so a hand-written precache list would go stale. The service worker caches what the browser actually asks for. A hit under `/assets/` is final (the URL cannot change); everything else is refreshed in the background. |
| Immutable cache for hashed files | `web/public/_headers` | Cloudflare serves static assets with `max-age=0, must-revalidate` by default. The files under `/assets/` are content-addressed, so the browser may keep them for a year. |
| Video at its own bit depth | `web/src/video.ts` (`planDepth`, `deepSpecOf`, `copyDeep`, `extractDeep`), `web/src/avi.ts` (`pixInfo`, `deepFrame`), `rust-core/src/yuv.rs`, `rust-core/src/api.rs` (`deep_frame`) | The browser's canvas is 8-bit, so a 10-bit camera clip used to lose two bits per channel before reaching a sheet. Now one decoded frame decides the route: if WebCodecs hands over the 10- or 12-bit planes (`I420P10`…: VP9 profile 2 in Chrome; Firefox and Safari did not, measured 2026-10-06), they are copied with `copyTo` and the core converts them to 16-bit RGB with the frame's own matrix, range and rotation; the frame keeps living in the video (`VideoRef.deep`) and is decoded again at 16 bits for sheets and ZIP, at 8 for previews. If the source is deeper than 8 bits but the browser gives only an opaque GPU frame (Chrome with 10-bit HEVC: `format` null; a WebGPU float16 texture of the same frame kept fewer than 8 bits' worth of levels, measured 2026-10-06), extraction goes through `ffmpeg.wasm`, which outputs the native YUV planes for the same core conversion (its own `rgb48le` maps 10-bit white to 65283, not 65535), with `-noautorotate`: ffmpeg's own rotation transposes the chroma planes and with them the chroma siting, so the core rotates after converting, from the angle in ffmpeg's log. HDR (PQ, HLG) and BT.2020 stay on the browser's colour-managed 8-bit canvas. `fast8` (the "Fast 8-bit decode" option) keeps the old route. Measured on 10 s of Lumix 4K HEVC 10-bit at 4 fps in Chrome: 2.0 s at 8 bits, 50.5 s at 10 bits (about 8 s of it is the one-off ffmpeg thread probe), 33 MB of OPFS per 16-bit 4K frame. The ffmpeg route now samples with `fps=…:round=up`, the frame at or just before each instant, as WebCodecs does; the default took the last frame of each interval, up to half an interval late. |
| An open tab survives a deploy | `web/carry-assets.mts`, `.github/workflows/ci.yml`, `web/src/main.ts` (`preload`) | Cloudflare replaces the whole file set on every deploy, and the SPA fallback answers a missing file with `index.html` and status 200. A tab loaded before a deploy asks for its own hashed `worker-*.js`, `pngmov-*.js` or `avi-*.js` later and got HTML: "Failed to fetch dynamically imported module" in the middle of a project (seen 2026-10-05). Two defences: CI copies into `dist/` every hashed file the live version references, plus those listed in the live `/asset-history.json` as retired less than 14 days ago, and publishes the new history; and the page imports `pngmov.ts` and `avi.ts` in the background once idle, so they are in the tab before any later deploy can remove them. |
| Hand-over from the old address | `deploy/old-domain/`, `web/src/migrate.ts`, `web/src/store.ts` (`mergeFromOldAddress`) | `localStorage` belongs to one origin. The old address serves a "moved" page that packs the store into `#mxm-migrate=<base64url>` and navigates to `mxmstudio.work`; `runMigration()` runs before the route or the store is read, merges (the new address wins a clash), remembers the importing browser's id and cleans the URL. Details in `INTEGRATIONS.md` §2. |

## 5) Known Architectural Risks

- **A stuck worker is recovered by replacement, not by interruption.**
  `web/src/pool.ts` watches each worker and, after ten minutes of silence,
  terminates and respawns it, because a synchronous WebAssembly call cannot be
  cancelled any other way. The timeout is deliberately generous: a false kill
  also destroys the work queued behind it, so the cost is asymmetric.
- **`layout.json` is a trust boundary that is not marked as one.** The file is
  meant to be shared between users, so `rust-core/src/scanproc.rs` and
  `rust-core/src/sheet.rs` receive attacker-shaped input, but the validation
  lives in scattered guards rather than in one place.
- **Two decode paths must agree.** `web/src/video.ts` (WebCodecs) and
  `web/src/avi.ts` (ffmpeg.wasm) both produce frames. Since the PNG, the
  thumbnail and the frame index all come from `web/src/frames.ts`, the two
  paths can no longer disagree on those; what remains theirs is the sampling
  of timestamps and the frame size. `avi.ts` reads the output size from
  ffmpeg's log, because a raw frame carries no header and ffmpeg rotates
  phone clips on its own.
- **The core is one crate.** `rust-core/src/sheet.rs` and `scanproc.rs` are
  about 50 KB each and hold the layout rules, the render and the scan
  pipeline together.

## 6) Evidence

- `web/src/main.ts`, `web/src/pool.ts`, `web/src/worker.ts`, `web/src/project.ts`
- `rust-core/src/api.rs`, `rust-core/src/lib.rs`
- `web/src/sw.ts`, `web/src/video.ts`, `web/src/avi.ts`, `web/src/frames.ts`, `web/src/opfs.ts`, `web/src/zip.ts`
- `web/src/export.ts`, `web/src/player.ts`, `web/src/gen.ts`, `rust-core/src/conform.rs`, `rust-core/src/photo.rs`
- `web/carry-assets.mts`, `web/src/migrate.ts`, `deploy/old-domain/`
- `rust-core/src/yuv.rs`, `web/src/video.ts`, `web/src/avi.ts`
