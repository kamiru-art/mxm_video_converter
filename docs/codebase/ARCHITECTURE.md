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
| Cancellation by `AbortSignal` | `web/src/video.ts`, `web/src/avi.ts`, `web/src/gen.ts`, `web/src/errors.ts` (`CancelledError`), `web/src/ui.ts` (`cancelButton`, `lockControls`) | Every long task takes a `signal`: the two extractors, sheet generation (checked between sheets and between frame files), the three video exports (between frames), and the scan batch (no more scans are taken from the queue; the ones already inside a worker finish, because the core cannot be interrupted). WebCodecs checks the signal between frames; `ffmpeg.wasm` cannot be interrupted inside `exec`, so the abort terminates the instance and the rejected call is read as the stop, not as a failure. A stop surfaces as `CancelledError` (`isCancelled`), which the phases announce as a stop, never as a failure; a half-written ZIP is discarded. While a task runs, `lockControls` disables every control of its panel except the Cancel button, because changing a format or dropping another file mid-way never affected the running task but the interface suggested it did. |
| Original audio in the final video | `web/src/video.ts` (`AudioFrom`, `pumpAudio`, `framesToMov`, `appendPcmAudio` in `buildVideoProres`), `web/src/phase4.ts`, `web/src/types.ts` (`VideoMeta.inicio_s`) | The frames are a stretch of the source at N fps, so the sound of that same stretch, cut to the length of the sequence and re-timed from zero, lines up with the frames by construction. Phase ① writes the start of the extracted range into the layout (`video.inicio_s`, passed through the core untouched as JSON); phase ④ reads it, reuses the phase ① video when it is still the same project, or takes the clip dropped there. For MP4/WebM, mediabunny decodes the source track (PCM by itself, the rest via WebCodecs) and encodes AAC, or Opus, or PCM as a last resort, with the audio pump running alongside the frame encoding; for the MOV exports ffmpeg reads the mounted original with `-ss`/`-t` and writes PCM. A source without an audio track, or a start past its end, yields a silent video and a toast, never an error. |
| Network-first document, cache-first assets | `web/src/sw.ts` | Vite hashes the asset names on each build, so a hand-written precache list would go stale. The service worker caches what the browser actually asks for. A hit under `/assets/` is final (the URL cannot change); everything else is refreshed in the background. |
| Immutable cache for hashed files | `web/public/_headers` | Cloudflare serves static assets with `max-age=0, must-revalidate` by default. The files under `/assets/` are content-addressed, so the browser may keep them for a year. |

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
