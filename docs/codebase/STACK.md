# Technology Stack

## 1) Runtime Summary

| Area | Value | Evidence |
|------|-------|----------|
| Primary languages | Rust (image processing core) and TypeScript (browser UI, worker, service worker, build scripts) | `rust-core/Cargo.toml`, `web/package.json`, `web/tsconfig.json` |
| Runtime | The user's web browser. There is no server-side runtime. | `web/wrangler.jsonc` (static `assets` only), `web/src/main.ts` |
| Build-time runtime | Node.js 24 (22.18 or later works: the build scripts are `.mts` files that Node runs through its own type stripping) | `.github/workflows/ci.yml` (`node-version: 24`), `web/package.json` (`engines`) |
| Package managers | Cargo (Rust), npm (TypeScript) | `rust-core/Cargo.lock`, `web/package-lock.json` |
| Module/build system | Vite 8 for the web bundle; `wasm-pack` for the Rust to WebAssembly step | `web/vite.config.ts`, `.github/workflows/ci.yml` |
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
the cyanotype curves, the PDF writer and the ZIP writer (`web/src/zipwriter.ts`,
ZIP64, store only) have no dependency: they are written in this repository.

### Web application (`web/package.json`)

| Dependency | Version | Role in system |
|------------|---------|----------------|
| `mediabunny` | ^1.55.3 | Demuxes and muxes video with WebCodecs. It is the first decode path and the MP4/WebM encode path. |
| `@ffmpeg/ffmpeg`, `@ffmpeg/core`, `@ffmpeg/util` | ^0.12 | The fallback decoder for files WebCodecs refuses, and the muxer for the two MOV exports. About 32 MB, loaded only when needed. |

There is no UI framework. The interface is built with `document.createElement`
through the `el()` helper in `web/src/ui.ts`.

## 3) Development Toolchain

| Tool | Purpose | Evidence |
|------|---------|----------|
| `cargo test` | The Rust test suite: 55 unit tests and 7 end-to-end integration tests. | `rust-core/src/*.rs`, `rust-core/tests/pipeline.rs` |
| `rustfmt` | Formatter, default style. CI runs `cargo fmt --check`. | `rust-core/rustfmt.toml`, `.github/workflows/ci.yml` |
| `cargo clippy` | Lint, warnings as errors, natively and for `wasm32-unknown-unknown` (the only target that compiles `api.rs`). Two lints allowed in `Cargo.toml` with the reason. | `rust-core/Cargo.toml` (`[lints]`), `.github/workflows/ci.yml` |
| `rust-toolchain.toml` | Pins the Rust channel, `clippy`, `rustfmt` and the wasm target, for CI and developers alike. | `rust-toolchain.toml` |
| `wasm-pack` | Compiles the core to WebAssembly, into `web/src/wasm/`. | `.github/workflows/ci.yml` |
| TypeScript 7 (`tsc`) | Type checking only: `npm run typecheck` runs three projects (page, workers, Node scripts) and `npm run build` runs it first. Vite does the transpiling and never checks types. | `web/tsconfig.json`, `web/tsconfig.worker.json`, `web/tsconfig.node.json` |
| Vite 8 | Development server and production bundle. | `web/package.json` |
| Biome 2 | Linter and formatter of the web (`npm run lint`, `npm run lint:fix`, `npm run format`). Chosen over ESLint + Prettier because TypeScript 7's package no longer ships the JavaScript compiler API that typescript-eslint needs. | `web/biome.jsonc`, `web/package.json` |
| `puppeteer-core` 25 | Drives headless Chrome for the browser test. | `web/e2e-run.mts` |
| `wrangler` 4 | Publishes to Cloudflare. It is not a declared dependency; CI pins the version in the action. | `.github/workflows/ci.yml`, `web/wrangler.jsonc` |

See `CONVENTIONS.md` §2 for what each tool enforces and why.

## 4) Key Commands

```bash
# Rust core
cd rust-core
cargo fmt --check                                             # formatting
cargo test                                                    # tests
cargo clippy --release --all-targets -- -D warnings           # lint (native)
cargo clippy --release --target wasm32-unknown-unknown -- -D warnings
wasm-pack build --release --target web --out-dir ../web/src/wasm

# Web application
cd web
npm install
npm run typecheck    # tsc over the page, the workers and the Node scripts
npm run lint         # biome: lint + formatting check (lint:fix applies fixes)
npm run dev          # development server (does NOT produce web/public/ffmpeg/)
npm run test:e2e     # browser end-to-end test; needs Chrome and ffmpeg
npm run build        # production bundle into web/dist
npx wrangler@4 deploy
```

## 5) Environment and Config

- Config sources: `rust-toolchain.toml`, `rust-core/Cargo.toml`,
  `rust-core/rustfmt.toml`, `web/package.json`, `web/biome.jsonc`,
  `web/vite.config.ts`, `web/wrangler.jsonc`, `.github/workflows/ci.yml`.
- Required environment variables: none at runtime. The application reads no
  environment variable, because it runs fully in the browser.
- Required CI secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. If
  the token is absent, the deploy step reports itself as skipped and the
  workflow stays green (`.github/workflows/ci.yml`).
- `web/wrangler.jsonc` deliberately does not hold the account id: CI passes
  it as a secret, and a local deploy exports `CLOUDFLARE_ACCOUNT_ID`.
- Runtime constraints: WebAssembly is necessary. WebCodecs gives the fast video
  path, and WebGPU gives the fast scan path; the application falls back when
  they are absent (`web/src/main.ts`, `web/src/webgpu.ts`).

## 6) Evidence

- `rust-toolchain.toml`, `rust-core/Cargo.toml`, `rust-core/Cargo.lock`, `rust-core/rustfmt.toml`
- `web/package.json`, `web/package-lock.json`, `web/biome.jsonc`
- `web/vite.config.ts`, `web/wrangler.jsonc`
- `.github/workflows/ci.yml`
