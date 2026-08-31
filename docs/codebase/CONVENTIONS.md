# Coding Conventions

These rules are read from the code. There is no linter configuration and no
formatter configuration in the repository, so the conventions below are
conventions of practice, not conventions the tooling enforces.

## 1) Naming Rules

| Item | Rule | Example | Evidence |
|------|------|---------|----------|
| Rust files | `snake_case.rs`, one for each domain area | `scanproc.rs`, `layoutfile.rs` | `rust-core/src/lib.rs` |
| Rust functions | `snake_case`, verb first | `build_layout`, `render_page`, `decode_qr` | `rust-core/src/sheet.rs` |
| Rust types | `PascalCase` | `Settings`, `ScanOptions`, `FrameInput`, `DynImg` | `rust-core/src/sheet.rs` |
| Rust constants | `SCREAMING_SNAKE_CASE` | `MAX_IMAGE_PIXELS`, `MAX_MOV_BYTES` | `rust-core/src/scanproc.rs` |
| JavaScript files | lowercase, no separator; a number for a phase | `phase1.js`, `pool.js`, `webgpu.js` | `web/src/` |
| JavaScript functions | `camelCase`; a phase entry point is `mount<Name>` | `mountPhase2`, `refreshPreview`, `pickConcurrency` | `web/src/main.js` |
| JavaScript constants | `SCREAMING_SNAKE_CASE` at module level | `RECYCLE_BYTES`, `LEGACY_ROUTES`, `FONT_HOSTS` | `web/src/pool.js`, `web/public/sw.js` |
| JSON keys that cross the boundary | Spanish, because they are the on-disk format of `layout.json` | `hojas`, `marcadores`, `ajustes`, `etiqueta` | `rust-core/src/layoutfile.rs` |

The Spanish JSON keys are a compatibility contract, not a style choice: a
`layout.json` written by an older version of the application must keep
loading. Do not rename them.

## 2) Formatting and Linting

- Formatter: none configured. The Rust code follows default `rustfmt` layout;
  the JavaScript uses two-space indentation and semicolons.
- Linter: `cargo clippy` runs in CI but cannot fail the build. The step is
  `cargo clippy --release --all-targets 2>&1 | tail -5`, so its exit status is
  the status of `tail` (`.github/workflows/ci.yml`). It is labelled
  "informational" in the workflow itself.
- There is no JavaScript linter.
- Run commands: `cargo test`, `cargo clippy` in `rust-core/`; `npm run build`
  and `npm run test:e2e` in `web/`.

## 3) Import and Module Conventions

- JavaScript uses ES modules with relative paths and an explicit `.js`
  extension: `import { run } from './pool.js';`.
- There is no path alias, no barrel file and no default export. Every module
  exports named values.
- A phase module never imports the WebAssembly module. It calls `run()` from
  `web/src/pool.js`. `web/src/worker.js` is the only importer of
  `./wasm/mxm_core.js`.
- Rust modules are declared in `rust-core/src/lib.rs` and refer to each other
  with `crate::`. Only `api.rs` carries `#[wasm_bindgen]`.

## 4) Error and Logging Conventions

- **Rust domain modules** return `Result<T, String>` with a message written for
  the user, in English, saying what to change: for example "Not enough room for
  the cells. Reduce columns/rows, margins, gutter or halo, or increase the
  sheet size/DPI." (`rust-core/src/sheet.rs`).
- **`api.rs`** converts those to `Result<T, JsValue>` through one `err()`
  helper and prefixes parse failures with the subject: `Invalid settings:`,
  `Invalid frame metadata:` (`rust-core/src/api.rs`).
- **Non-fatal problems inside a scan** are collected instead of thrown, with
  the local `warn!` macros in `rust-core/src/scanproc.rs`, and are returned in
  the `advertencias` array of the result.
- **`worker.js`** wraps every call in `try`/`catch`, returns `{ ok, value,
  error }`, and sets `poisoned` when the core panicked.
- **`pool.js`** turns a failed result into a rejected promise, and also rejects
  every pending promise if the worker script itself fails to load.
- **The interface** reports with `toast(message, 'err')` from `web/src/ui.js`.
  Every `async` handler ends in a `catch` that toasts: a rejection that only
  reaches the console is invisible to the user, who sees the button do
  nothing. The deliberate exception is `refreshPreview()` in
  `web/src/phase1.js`, which runs on every control change and only logs: a
  toast on each keystroke would be worse than the silence.
- `console.*` is used for diagnostics only, never as the way the user is told
  something.
- There is no telemetry, no analytics and no remote logging. Nothing leaves the
  browser.

## 5) Testing Conventions

- Rust unit tests live in the same file as the code, in a `#[cfg(test)] mod
  tests` block at the end.
- Rust integration tests live in `rust-core/tests/pipeline.rs`.
- A test that fixes a defect states the defect in a comment above the
  assertions, so the reason survives: see `zero_cols_or_rows_is_rejected` in
  `rust-core/src/sheet.rs`.
- There is no mocking. The Rust tests build synthetic images and run the real
  pipeline; the browser test drives the real page in real Chrome.
- There is no coverage target and no coverage tooling. `.coverage` is ignored.

## 6) Known Convention Divergence

The comments in the source are Spanish. The user interface strings, the error
messages that reach the user, the README and the header of the CI workflow are
English. Two comment blocks inside `.github/workflows/ci.yml` are Spanish
inside an otherwise English file. `[ASK USER]` — see the question in the
summary.

## 7) Evidence

- `rust-core/src/api.rs`, `rust-core/src/sheet.rs`, `rust-core/src/scanproc.rs`
- `web/src/pool.js`, `web/src/worker.js`, `web/src/ui.js`, `web/src/main.js`
- `.github/workflows/ci.yml`
