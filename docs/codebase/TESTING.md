# Testing

## 1) Frameworks and Layers

| Layer | Tool | What it covers | Evidence |
|-------|------|----------------|----------|
| Rust unit | The built-in `#[test]` harness | 40 tests across the domain modules | `rust-core/src/*.rs` |
| Rust integration | The same harness, in `tests/` | 6 end-to-end round trips: build a sheet, simulate a scan of it, recover the frames | `rust-core/tests/pipeline.rs` |
| Browser end-to-end | `puppeteer-core` driving headless Chrome against a page the runner serves itself | The real pipeline in a real browser: workers, WebAssembly, WebGPU, WebCodecs, `ffmpeg.wasm` | `web/e2e-run.mjs`, `web/e2e.html`, `web/src/e2e.js` |

There are **no JavaScript unit tests**. The browser test is the only coverage
of `web/src`, and it does not call any `mount*` function, so the DOM wiring of
the phases is not exercised.

## 2) Current State

Measured on the current tree with `cargo test --release`:

```
Unit tests (src/lib.rs):          40 passed; 0 failed
Integration (tests/pipeline.rs):   6 passed; 0 failed
Doc-tests:                          0
```

Two of the 40 unit tests assert nothing. `mod debug_tests` in
`rust-core/src/qr.rs` holds two `#[test]` functions that only `println!`; they
pass whatever the code does. They are scaffolding kept from the port and
should be removed or given assertions.

## 3) How to Run

```bash
cd rust-core && cargo test              # fast, native, no browser
cd web && npm run test:e2e              # needs Google Chrome and ffmpeg
```

The browser test builds the site with `MXM_E2E=1`, starts its own HTTP server
over `web/dist`, and drives `e2e.html`. `web/e2e-run.mjs` generates its own
sample media with `ffmpeg` when `ffmpeg` is present: an MP4 for the WebCodecs
path and an MPEG-4 ASP AVI, chosen because WebCodecs will not decode it and it
therefore exercises the `ffmpeg.wasm` fallback. If `ffmpeg` is absent the page
skips the video section instead of failing. CI installs `ffmpeg` so the
section always runs there.

`CHROME_PATH` selects the browser binary (`.github/workflows/ci.yml`).

## 4) File Organization and Naming

- Rust unit tests: a `#[cfg(test)] mod tests` block at the end of the module
  they test. Test functions are `snake_case` and describe the behaviour, not
  the function: `zero_cols_or_rows_is_rejected`, `sixteen_bit_scan_keeps_depth`,
  `v1_converts`.
- Rust integration tests: `rust-core/tests/pipeline.rs`.
- Browser test: the assertions live in `web/src/e2e.js`, and `web/e2e-run.mjs`
  is only the runner.

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
`.coverage` is ignored by git. `[ASK USER]` — see the question in the summary.

Known gaps, by size:

- `rust-core/src/scanproc.rs`, the largest and most complex module, has no
  unit tests. It is covered only indirectly by the 6 integration round trips.
- `rust-core/src/api.rs`, the whole WebAssembly boundary, has no unit tests.
- All of `web/src` has no unit tests. The defects found in the last review
  that live in the DOM wiring of the phases were in exactly this gap.

## 7) CI

`.github/workflows/ci.yml` runs two jobs on every push and every pull request.
The `rust` job runs the tests and clippy. The `web` job waits for it, compiles
the core to WebAssembly, builds the site, runs the browser test, and — only on
a push to `main` — deploys the same build it just tested. The deploy lives
inside the `web` job on purpose, so that exactly one build exists in the
pipeline and what gets published is what the test ran against.

## 8) Evidence

- `rust-core/tests/pipeline.rs`, `rust-core/src/qr.rs`
- `web/e2e-run.mjs`, `web/e2e.html`, `web/src/e2e.js`
- `web/package.json`, `.github/workflows/ci.yml`
