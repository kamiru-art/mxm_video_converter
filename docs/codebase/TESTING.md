# Testing

## 1) Frameworks and Layers

| Layer | Tool | What it covers | Evidence |
|-------|------|----------------|----------|
| Rust unit | The built-in `#[test]` harness | 65 tests across the domain modules, 9 of them for the two new modules (`conform.rs`, `photo.rs`), each preceded by the list of the ways it could fail | `rust-core/src/*.rs` |
| Rust integration | The same harness, in `tests/` | 7 end-to-end round trips: build a sheet, simulate a scan of it, recover the frames | `rust-core/tests/pipeline.rs` |
| Rust lint and format | `cargo clippy -- -D warnings` (native and wasm32), `cargo fmt --check` | Every warning is an error; see `CONVENTIONS.md` §2 | `rust-core/Cargo.toml`, `rust-core/rustfmt.toml` |
| Web lint and format | Biome (`npm run lint`) | `any`, `@ts-ignore`, default exports, non-null assertions, floating promises, formatting | `web/biome.jsonc` |
| Browser end-to-end, pipeline | Chrome or Zen/Firefox (`puppeteer-core`, WebDriver BiDi) or Safari (`safaridriver`), against a page the runner serves itself | The real pipeline in a real browser: workers, WebAssembly, WebGPU, WebCodecs, `ffmpeg.wasm`; the lossless exports are then decoded by the machine's own `ffmpeg` and compared sample by sample at 16 bits | `web/e2e-run.mts`, `web/e2e-verify.mts`, `web/e2e-browsers.mts`, `web/e2e.html`, `web/src/e2e.ts` |
| Browser end-to-end, interface | The same three drivers, on the real `index.html`, at 1440×900 and at 390×844 (a phone; Chrome also emulates touch and density) | The whole example project by clicks: sheets, simulated scans, lossless MOV and PNG ZIP, the in-page preview playing; no sideways scroll on any screen; the downloaded MOV checked with `ffprobe` | `web/e2e-ui.mts` |
| Type check | `tsc` under `strict`, three projects | Every call across the worker boundary, the DOM wiring of the phases, the layout and settings shapes; it runs before any build (`npm run typecheck`) | `web/tsconfig.json`, `web/tsconfig.worker.json`, `web/tsconfig.node.json` |

There are **no TypeScript unit tests**. The two browser tests are the
coverage of `web/src`: the pipeline test calls the modules directly, and the
interface test drives the `mount*` phases through their buttons.

## 2) Current State

Measured on the current tree with `cargo test --release`:

```
Unit tests (src/lib.rs):          65 passed; 0 failed
Integration (tests/pipeline.rs):   7 passed; 0 failed
Doc-tests:                          0
```

Every test asserts something. The two QR tests that used to only print
(`mod roundtrip_tests` in `rust-core/src/qr.rs`) now fix the smallest QR side
the reader recovers (47 px) and require the three QRs of the printer test
page to read back from their own crops.

## 3) How to Run

```bash
cd rust-core && cargo test                        # fast, native, no browser
cd web && npm run test:e2e                        # pipeline, Chrome (needs ffmpeg)
cd web && npm run test:e2e -- --browser=zen       # the same in Zen (ZEN_PATH / FIREFOX_PATH)
cd web && npm run test:e2e -- --browser=safari    # the same in Safari
cd web && npm run test:ui [-- --browser=zen|safari]   # the interface, desktop and phone

# Safari needs "Allow Remote Automation" switched on once (Settings →
# Developer); safaridriver refuses the session otherwise.
```

The browser test builds the site with `MXM_E2E=1`, starts its own HTTP server
over `web/dist`, and drives `e2e.html`. `web/e2e-run.mts` generates its own
sample media with `ffmpeg` when `ffmpeg` is present: an MP4 for the WebCodecs
path and an MPEG-4 ASP AVI, chosen because WebCodecs will not decode it and it
therefore exercises the `ffmpeg.wasm` fallback. If `ffmpeg` is absent the page
skips the video section instead of failing. CI installs `ffmpeg` so the
section always runs there. Each decoder is also stopped half-way through an
`AbortSignal`: the test requires `cancelled: true`, fewer frames than the
clip has, and consecutive frame indices, because the PNGs are encoded in
parallel and must still come out in order. The lazy path is covered end to
end: an extraction with `lazy: true` yields no PNG, three frames are
re-decoded by timestamp and come back with the requested indices, a sheet
and a ZIP are generated from frames that live in the video, and the PNG the
ZIP produces is byte-identical to the one the eager extraction made of the
same frame. The `ffmpeg.wasm` sample is extracted with `lazy: true` too and
must still deliver PNGs, and the OPFS cache does a byte-exact round trip.
Cancellation is covered where it is cheap to prove: `generateSheets` with an
already-aborted signal must throw `CancelledError` before the first sheet,
and aborting from `onProgress` after the first sheet must stop before the
second (the sheets are rendered several at a time, so the stop is checked
again as each one is collected); the lossless export aborted after writing
its first frame must throw the same error.

The final video is lossless only, and its test is the hardest scenario in
the suite. A sequence of five positions and three drawings: a 16-bit PNG of
the majority size (it must be copied as it is), an 8-bit PNG of 322×179
(centred on 320×180 without resampling and widened to 16 bits) and a 16-bit
TIFF (turned into a 16-bit PNG by the core), with repeats, as deduplication
leaves them. The page checks the plan (320×180, 16 bits, 1 copied, 2
conformed, none resized) and the sound: the stereo 44.1 kHz sample, cut from
0.5 s, must be 2.5 s of PCM whose dominant frequency (zero crossings) is 440
Hz before t = 1 s and 880 Hz after, which proves the cut and the re-timing
at once. The page then leaves the MOV, the same sequence as a ZIP of PNGs
with a WAV, a MOV with one transparent frame, and all the sources, and
`web/e2e-verify.mts` decodes them with the local `ffmpeg`: every MOV frame
must equal its source sample by sample at 16 bits, every PNG in the ZIP
must decode to the same frame as the MOV, and the alpha MOV must be RGBA64
with the alpha intact. An 8-bit source is read at 8 bits and widened there
(v · 257): swscale's own rgb24 → rgb48 is not exact (111 → 28416, not
28527) and would be a wrong reference. The sound combinations (5.1 folded to
two channels with the centre kept, a source that ends early, a range that
does not exist, a silent source) run on four same-size 8-bit PNGs, which
must all be copied as they are.

The 16-bit sheet path is covered end to end in the same run: four 16-bit
frames with a fine gradient become a 16-bit sheet in PNG, TIFF and PDF (the
PDF declares `/BitsPerComponent 16`); more than 256 distinct red levels must
survive inside one frame on the sheet (8 bits cannot hold more); that sheet
is processed as a 16-bit scan, whose four crops must be 16-bit and of one
size; and the lossless export must copy them as they are. The rotated 8-bit
scan must also yield crops of one size.
The PDF that phase 1 assembles from the streamed chunks must be one whole
file: header first, `%%EOF` last, `startxref` pointing at the table, and
the page image declared with the PNG predictor; the Rust tests of
`pdf.rs` walk the xref and require every offset to land on its object.
Each run writes `artifacts/e2e/browser-pipeline.<browser>.json` (git-ignored)
and its `.sha256`: the SHA-256 of the inputs and of the deterministic outputs
(sheet, PDF, TIFF, layout, cut-out frames, calibration page, the 16-bit sheet,
the decoded lossless frames), the `ffmpeg` checks, and every step, with no
clock in it, so two runs on the same machine write the same bytes. The files
the verifier read stay in `artifacts/e2e/<browser>/`. CSP violations are
heard by the page itself (`securitypolicyviolation`), so Safari, whose
console WebDriver cannot read, counts them like the others. The interface
test writes `artifacts/e2e/ui.<browser>.json` and a screenshot of every
screen in `artifacts/e2e/ui/<browser>-<desktop|phone>/`.
The test page must be cross-origin isolated (the runner sends every header
of the `/*` block of `public/_headers`), so the `ffmpeg.wasm` samples run
through the multithreaded core; the log line says which core ran.

`CHROME_PATH` selects the browser binary (`.github/workflows/ci.yml`).

## 4) File Organization and Naming

- Rust unit tests: a `#[cfg(test)] mod tests` block at the end of the module
  they test. Test functions are `snake_case` and describe the behaviour, not
  the function: `zero_cols_or_rows_is_rejected`, `sixteen_bit_scan_keeps_depth`,
  `v1_converts`.
- Rust integration tests: `rust-core/tests/pipeline.rs`.
- Browser tests: the pipeline assertions live in `web/src/e2e.ts`;
  `web/e2e-run.mts` runs them, `web/e2e-verify.mts` checks the exported files
  from outside the browser, `web/e2e-browsers.mts` is the shared server and
  the three drivers, and `web/e2e-ui.mts` is the interface test.

## 5) Mocking Strategy

There is none, deliberately. The Rust tests build synthetic images in memory
(`synth_frame` in `rust-core/tests/pipeline.rs` makes a recognisable frame from
a base colour and a diagonal stripe), then run the real code. The integration
tests simulate a scan by applying a real homography, real noise and a real
rotation to a rendered sheet, and then require the pipeline to recover the
frames. The browser test uses a real browser, real workers and real media.

This is the right choice for image processing, where a mock would assert
against the shape of the code rather than against the picture.

## 6) Coverage Expectation

There is no coverage target, no coverage tool and no coverage gate.
`.coverage` is ignored by git.

Known gaps, by size:

- `rust-core/src/scanproc.rs`, the largest and most complex module, has no
  unit tests. It is covered only indirectly by the 7 integration round trips.
- `rust-core/src/api.rs`, the whole WebAssembly boundary, has no unit tests.
- All of `web/src` has no unit tests. The interface test drives one path
  through each phase (the example project); the other options of phase 1
  (video input, cyanotype, presets) are not clicked.
- CI runs the pipeline test in Chrome only; Zen, Safari and the interface
  test are run by hand. [ASK USER] whether CI should run the interface test.

## 7) CI

`.github/workflows/ci.yml` runs two jobs on every push to `main` or a `feat/`
branch and on every pull request. The `rust` job runs `cargo fmt --check`,
the tests, and clippy with warnings as errors, natively and for wasm32. The
`web` job waits for it, compiles the core to WebAssembly, type-checks, runs
Biome (`npm run lint`), runs the browser test, builds the site, and — only on
a push to `main` — deploys the same build it just tested. The deploy lives
inside the `web` job on purpose, so that exactly one build exists in the
pipeline and what gets published is what the test ran against.

## 8) Evidence

- `rust-core/tests/pipeline.rs`, `rust-core/src/qr.rs`
- `web/e2e-run.mts`, `web/e2e-verify.mts`, `web/e2e-browsers.mts`, `web/e2e-ui.mts`
- `web/e2e.html`, `web/src/e2e.ts`
- `web/package.json`, `.github/workflows/ci.yml`
