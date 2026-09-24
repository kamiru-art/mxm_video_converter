# CLAUDE.md

MXM Studio: a Rust core (`rust-core/`, compiled to WebAssembly) and a Vite
site (`web/`) that runs the whole pipeline in the browser. The `main` branch
deploys to mxm.sebastianlopez.me from CI. Notes on the codebase live in
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

The E2E suite drives the built site in headless Chrome. It needs Google Chrome
(or `CHROME_PATH`), `ffmpeg`, and the core compiled to `web/src/wasm`:

```bash
cd rust-core && wasm-pack build --release --target web --out-dir ../web/src/wasm
cd web && npm ci && npm run test:e2e      # about 25 s
```

Scenario: four synthetic frames go onto a contact sheet (PNG, PDF, TIFF,
layout), the sheet is "scanned" rotated 2 degrees and scaled, and the core has
to find the sheet by its marker IDs and cut out all four frames, by WASM and by
WebGPU. Then a mirrored cyanotype with a QR is scanned, then again with the QR
unreadable and the sheet assigned by hand. The video half extracts frames from
MP4, ProRes MOV and MPEG-4 AVI (the last two only decode through
`ffmpeg.wasm`), cancels half-way, builds sheets and a ZIP64 lazily from the
video, and exports MP4, lossless MOV and ProRes with the original sound cut to
the frames (mono, stereo 44.1 kHz, 5.1 down to two channels, a source that ends
early, a silent one). The page runs under the CSP and COOP/COEP headers of
`web/public/_headers`; any violation fails the run.

Artifact: `artifacts/e2e/browser-pipeline.json` (git-ignored, rewritten every
run) with the result, the SHA-256 of every input (generated samples, WASM core,
headers) and of every deterministic output (sheet, PDF, TIFF, layout, cut-out
frames, calibration page), and each checked step. It has no clocks in it: two
runs on the same machine write the same bytes. To verify, check
`shasum -a 256 -c artifacts/e2e/browser-pipeline.json.sha256` from
`artifacts/e2e/`, and compare the `outputs` block across runs or commits; a
change there means the core now produces different sheets or frames.

The Rust tests (`cd rust-core && cargo test --release`) are the isolated
layer: `tests/pipeline.rs` does sheet-to-scan round trips with real noise and
homographies, and the unit tests guard edge cases the browser run does not
reach (memory budgets, 32-bit overflow, ArUco error correction, QR limits).
