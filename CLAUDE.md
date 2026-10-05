# CLAUDE.md

MXM Studio: a Rust core (`rust-core/`, compiled to WebAssembly) and a Vite
site (`web/`) that runs the whole pipeline in the browser. The `main` branch
deploys to mxmstudio.work (the MXM Studio Cloudflare account) from CI; the
old address, mxm.sebastianlopez.me, hands users and their saved data over
(`deploy/old-domain/`, `web/src/migrate.ts`). Notes on the codebase live in
`docs/codebase/` (tests: `docs/codebase/TESTING.md`).

## Testing

- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.
- When writing E2E tests don't pick the simplest possible scenario to prove it works; pick a medium to hard scenario when verifying the work with E2E tests.
- Tautological tests considered harmful.
- Change-detector tests considered harmful.
- Do not create regression tests for bug fixes without a genuine gap in behavior testing.

### In this repo

Two E2E suites drive the built site. They need `ffmpeg`, the core compiled to
`web/src/wasm`, and a browser: Chrome (or `CHROME_PATH`) by default, Zen or
Firefox with `--browser=zen` (`ZEN_PATH`), Safari with `--browser=safari`
(once: Safari Settings → Developer → Allow Remote Automation):

```bash
cd rust-core && wasm-pack build --release --target web --out-dir ../web/src/wasm
cd web && npm ci && npm run test:e2e      # pipeline, about 30 s
cd web && npm run test:ui                 # interface, desktop and phone size
```

Scenario: four synthetic frames go onto a contact sheet (PNG, PDF, TIFF,
layout), the sheet is "scanned" rotated 2 degrees and scaled, and the core has
to find the sheet by its marker IDs and cut out all four frames, by WASM and by
WebGPU. Then a mirrored cyanotype with a QR is scanned, then again with the QR
unreadable and the sheet assigned by hand. The video half extracts frames from
MP4, ProRes MOV and MPEG-4 AVI (the last two only decode through
`ffmpeg.wasm`), cancels half-way, builds sheets and a ZIP64 lazily from the
video, and exports the final video, lossless and compressed: a sequence
mixing a 16-bit PNG, an 8-bit PNG two pixels off size and a 16-bit TIFF goes
into a MOV and a PNG ZIP with the original sound (stereo 44.1 kHz, 5.1 down
to two channels, a source that ends early, a silent one), and into an MP4.
The local `ffmpeg` then decodes those files (`web/e2e-verify.mts`): every
lossless frame must equal its source sample by sample at 16 bits; the MP4
must be H.264 (or the fallback codec) with its frames in the timeline order,
its colours true (mean shift within ±3 levels) and its sound in sync. On a
sequence with motion and grain, the three presets must step down in size and
in PSNR against a lossless reference (High ≥ 28 dB), a fixed bitrate must
land within ±40 %, and a 642×361 frame (a width Chrome used to shift by a
pixel) must come out 644×362 with a white edge and the drawing in place. A 16-bit chain runs too: 16-bit frames →
16-bit sheet (PNG, TIFF, PDF) → 16-bit scan → crops of one size → copied into
the MOV. The page runs under the CSP and COOP/COEP headers of
`web/public/_headers`; any violation fails the run.

The interface suite (`web/e2e-ui.mts`) clicks through the example project on
`index.html` at 1440×900 and 390×844: sheets, simulated scans, MOV, ZIP and
MP4 (the quality and bitrate fields appear only when they apply), the
in-page preview playing, and no sideways scroll on any screen.

Artifacts (git-ignored, rewritten every run): `artifacts/e2e/browser-pipeline.<browser>.json`
with the result, the SHA-256 of every input (generated samples, WASM core,
headers) and of every deterministic output (sheet, PDF, TIFF, layout, cut-out
frames, calibration page, 16-bit sheet, decoded lossless frames), and each
checked step; `artifacts/e2e/ui.<browser>.json` with screenshots in
`artifacts/e2e/ui/`. It has no clocks in it: two
runs on the same machine write the same bytes. To verify, check
`shasum -a 256 -c browser-pipeline.chrome.json.sha256` from
`artifacts/e2e/`, and compare the `outputs` block across runs or commits; a
change there means the core now produces different sheets or frames.

The Rust tests (`cd rust-core && cargo test --release`) are the isolated
layer: `tests/pipeline.rs` does sheet-to-scan round trips with real noise and
homographies, and the unit tests guard edge cases the browser run does not
reach (memory budgets, 32-bit overflow, ArUco error correction, QR limits).
