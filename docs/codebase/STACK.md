# Technology Stack

## 1) Runtime Summary

| Area | Value | Evidence |
|------|-------|----------|
| Primary languages | Rust (image processing core) and JavaScript (browser UI) | `rust-core/Cargo.toml`, `web/package.json` |
| Runtime | The user's web browser. There is no server-side runtime. | `web/wrangler.jsonc` (static `assets` only), `web/src/main.js` |
| Build-time runtime | Node.js 22 | `.github/workflows/ci.yml` (`node-version: 22`) |
| Package managers | Cargo (Rust), npm (JavaScript) | `rust-core/Cargo.lock`, `web/package-lock.json` |
| Module/build system | Vite 8 for the web bundle; `wasm-pack` for the Rust to WebAssembly step | `web/vite.config.js`, `.github/workflows/ci.yml` |
| Compile target | `wasm32-unknown-unknown`, `crate-type = ["cdylib", "rlib"]` | `rust-core/Cargo.toml` |

Note on `usize`: the shipped target is 32-bit. Any width assumption taken from
a native `cargo test` run does not hold in the browser. See `CONCERNS.md`.

## 2) Production Frameworks and Dependencies

### Rust core (`rust-core/Cargo.toml`)

| Dependency | Version | Role in system |
|------------|---------|----------------|
| `image` | 0.25 | Decodes and encodes PNG, JPEG, TIFF, BMP and WebP. Default features are off; the five codecs are selected explicitly. |
| `serde` / `serde_json` | 1 | Every value that crosses the WebAssembly boundary is JSON. |
| `qrcode` | 0.14 | Draws the QR code of each frame. |
| `rqrr` | 0.7 | Reads the QR codes back from a scan. |
| `fontdue` | 0.9 | Rasterises the sheet labels. |
| `flate2` | 1 | Compresses the PDF streams. `rust_backend` feature, so no C dependency. |
| `wasm-bindgen`, `js-sys`, `serde-wasm-bindgen` | 0.2 / 0.3 / 0.6 | The browser boundary. `wasm32` target only. |
| `console_error_panic_hook` | 0.1 | Sends a Rust panic to the browser console. `wasm32` target only. |

The ArUco marker generation and detection, the RANSAC homography, the warp,
the cyanotype curves and the PDF writer have no dependency: they are written
in this repository.

### Web application (`web/package.json`)

| Dependency | Version | Role in system |
|------------|---------|----------------|
| `mediabunny` | ^1.55.3 | Demuxes and muxes video with WebCodecs. It is the first decode path and the MP4/WebM encode path. |
| `@ffmpeg/ffmpeg`, `@ffmpeg/core`, `@ffmpeg/util` | ^0.12 | The fallback decoder for files WebCodecs refuses, and the muxer for the two MOV exports. About 32 MB, loaded only when needed. |
| `fflate` | ^0.8.3 | Builds the result ZIP files in the browser. |

There is no UI framework. The interface is built with `document.createElement`
through the `el()` helper in `web/src/ui.js`.

## 3) Development Toolchain

| Tool | Purpose | Evidence |
|------|---------|----------|
| `cargo test` | The Rust test suite: 40 unit tests and 6 end-to-end integration tests. | `rust-core/src/*.rs`, `rust-core/tests/pipeline.rs` |
| `cargo clippy` | Lint. CI runs it but does not fail on it: the step ends with `\| tail -5`. | `.github/workflows/ci.yml` |
| `wasm-pack` | Compiles the core to WebAssembly, into `web/src/wasm/`. | `.github/workflows/ci.yml` |
| Vite 8 | Development server and production bundle. | `web/package.json` |
| `puppeteer-core` 25 | Drives headless Chrome for the browser test. | `web/e2e-run.mjs` |
| `wrangler` 4 | Publishes to Cloudflare. It is not a declared dependency; CI pins the version in the action. | `.github/workflows/ci.yml`, `web/wrangler.jsonc` |

There is no formatter configuration and no linter configuration in the
repository: no `rustfmt.toml`, no `clippy.toml`, no ESLint or Prettier file.

## 4) Key Commands

```bash
# Rust core
cd rust-core
cargo test                                                    # tests
wasm-pack build --release --target web --out-dir ../web/src/wasm

# Web application
cd web
npm install
npm run dev          # development server (does NOT produce web/public/ffmpeg/)
npm run test:e2e     # browser end-to-end test; needs Chrome and ffmpeg
npm run build        # production bundle into web/dist
npx wrangler@4 deploy
```

## 5) Environment and Config

- Config sources: `rust-core/Cargo.toml`, `web/package.json`, `web/vite.config.js`,
  `web/wrangler.jsonc`, `.github/workflows/ci.yml`.
- Required environment variables: none at runtime. The application reads no
  environment variable, because it runs fully in the browser.
- Required CI secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. If
  the token is absent, the deploy step reports itself as skipped and the
  workflow stays green (`.github/workflows/ci.yml`).
- `web/wrangler.jsonc` also holds a copy of the account id in the repository.
- Runtime constraints: WebAssembly is necessary. WebCodecs gives the fast video
  path, and WebGPU gives the fast scan path; the application falls back when
  they are absent (`web/src/main.js`, `web/src/webgpu.js`).

## 6) Evidence

- `rust-core/Cargo.toml`, `rust-core/Cargo.lock`
- `web/package.json`, `web/package-lock.json`
- `web/vite.config.js`, `web/wrangler.jsonc`
- `.github/workflows/ci.yml`
