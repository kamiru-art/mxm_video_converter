# Coding Conventions

These rules are read from the code, and since 2026-09-06 the tooling enforces
the ones it can: `rustfmt` and `clippy` for the core (`rust-core/rustfmt.toml`,
the `[lints]` table of `rust-core/Cargo.toml`), Biome for the web
(`web/biome.jsonc`), and the type system (TypeScript under `strict`,
`npm run typecheck`). CI fails on any of them. The rest of the conventions
below are conventions of practice.

## 1) Naming Rules

| Item | Rule | Example | Evidence |
|------|------|---------|----------|
| Rust files | `snake_case.rs`, one for each domain area | `scanproc.rs`, `layoutfile.rs` | `rust-core/src/lib.rs` |
| Rust functions | `snake_case`, verb first | `build_layout`, `render_page`, `decode_qr` | `rust-core/src/sheet.rs` |
| Rust types | `PascalCase` | `Settings`, `ScanOptions`, `FrameInput`, `DynImg` | `rust-core/src/sheet.rs` |
| Rust constants | `SCREAMING_SNAKE_CASE` | `MAX_IMAGE_PIXELS`, `MAX_MOV_BYTES` | `rust-core/src/scanproc.rs` |
| TypeScript files | lowercase, no separator; a number for a phase | `phase1.ts`, `pool.ts`, `webgpu.ts` | `web/src/` |
| TypeScript types | `PascalCase` interfaces, no `I` prefix; shared shapes live in `types.ts` | `Settings`, `Layout`, `ScanResult`, `Bytes` | `web/src/types.ts` |
| TypeScript functions | `camelCase`; a phase entry point is `mount<Name>` | `mountPhase2`, `refreshPreview`, `pickConcurrency` | `web/src/main.ts` |
| TypeScript constants | `SCREAMING_SNAKE_CASE` at module level | `RECYCLE_BYTES`, `LEGACY_ROUTES`, `FONT_HOSTS` | `web/src/pool.ts`, `web/src/sw.ts` |
| JSON keys that cross the boundary | Spanish, because they are the on-disk format of `layout.json` | `hojas`, `marcadores`, `ajustes`, `etiqueta` | `rust-core/src/layoutfile.rs` |

The Spanish JSON keys are a compatibility contract, not a style choice: a
`layout.json` written by an older version of the application must keep
loading. Do not rename them.

## 2) Formatting and Linting

### Rust core

- Formatter: `rustfmt` with the default style. `rust-core/rustfmt.toml` only
  records the decision; CI runs `cargo fmt --check` before the tests.
- Linter: `cargo clippy` with warnings as errors, twice: natively with
  `--all-targets` (unit and integration tests included) and for
  `wasm32-unknown-unknown`, because `api.rs` is
  `#![cfg(target_arch = "wasm32")]` and the native pass never compiles it.
  Two lints are allowed crate-wide in the `[lints.clippy]` table of
  `Cargo.toml`, with the reason next to them: `needless_range_loop` (in the
  pixel kernels the index is the computation) and `too_many_arguments`.
  Anything else must be fixed, or allowed at the site with a comment.
- The toolchain is pinned in `rust-toolchain.toml` at the repository root
  (channel, `clippy`, `rustfmt`, the wasm target). Every developer and CI get
  the same compiler, so a new Rust release with new lints cannot break CI on
  its own. To upgrade: change the channel, run both clippy passes, fix what
  appears, commit together.

### Web application

- Formatter and linter: Biome, configured in `web/biome.jsonc`. Two-space
  indentation, semicolons, single quotes, trailing commas, 100 columns.
  `npm run lint` is what CI runs (`biome check`: lint plus formatting);
  `npm run lint:fix` applies the safe fixes; `npm run format` only formats.
  `style.css` is linted but not formatted: it is written compactly on
  purpose, several declarations per line, and the formatter would triple it.
- Biome rather than ESLint + Prettier because the web compiles with
  TypeScript 7, whose npm package no longer ships the JavaScript compiler API
  that typescript-eslint parses with. Biome has its own parser.
- The rules are the conventions the code already followed: no `any`
  (`noExplicitAny`), no `@ts-ignore` (`noTsIgnore`), no default export
  (`noDefaultExport`, off for `vite.config.ts`, which Vite requires), types
  imported with `import type` (`useImportType`), no non-null assertion
  (`noNonNullAssertion`), and no floating promise (`noFloatingPromises`). A
  promise that is deliberately not awaited, because the function already
  catches its own errors (`refreshPreview`, `processScans`, the service
  worker's `put`), is marked with `void`.
- `tsc` runs with `strict`, `verbatimModuleSyntax` and `erasableSyntaxOnly`
  over three projects: `tsconfig.json` (the page, DOM library),
  `tsconfig.worker.json` (the processing worker and the service worker,
  WebWorker library) and `tsconfig.node.json` (the build and test scripts,
  Node types). The DOM and WebWorker libraries cannot share one program,
  which is why there are three.
- A value from `JSON.parse` is narrowed with one `as` cast to the interface
  in `types.ts` that describes it, at the parse site and nowhere else. Catch
  variables are `unknown`; `errMsg()` from `web/src/errors.ts` turns them
  into a message.

### Commands

```bash
cd rust-core
cargo fmt --check                                   # or `cargo fmt` to apply
cargo test
cargo clippy --release --all-targets -- -D warnings
cargo clippy --release --target wasm32-unknown-unknown -- -D warnings

cd ../web
npm run typecheck
npm run lint                                        # or `npm run lint:fix`
```

The two formatting commits (rustfmt over the core, Biome over the web) are
listed in `.git-blame-ignore-revs`; `git config blame.ignoreRevsFile
.git-blame-ignore-revs` makes `git blame` skip them.

## 3) Import and Module Conventions

- TypeScript uses ES modules with relative paths and an explicit `.ts`
  extension: `import { run } from './pool.ts';` (Vite resolves them;
  `allowImportingTsExtensions` lets `tsc` accept them). Types are imported
  with `import type`.
- There is no path alias, no barrel file and no default export. Every module
  exports named values.
- A phase module never imports the WebAssembly module. It calls `run()` from
  `web/src/pool.ts`. `web/src/worker.ts` is the only importer of
  `./wasm/mxm_core.js`.
- The command table between the pool and the worker is typed once, in
  `web/src/commands.ts`: `run('scan_process', args)` only accepts the
  arguments of that command and resolves to its result type, and the
  handler table in `worker.ts` is checked against the same map. Adding a
  core function means adding one entry there and one handler.
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
- **`worker.ts`** wraps every call in `try`/`catch`, returns `{ ok, value,
  error }`, and sets `poisoned` when the core panicked.
- **`pool.ts`** turns a failed result into a rejected promise, and also rejects
  every pending promise if the worker script itself fails to load. A worker
  that fails before its first reply is not respawned from the error handler:
  the next `run()` creates it again, at most three times in a row and then
  once a minute, and the rejection tells the user to reload the page.
- **The interface** reports with `toast(message, 'err')` from `web/src/ui.ts`.
  Every `async` handler ends in a `catch` that toasts: a rejection that only
  reaches the console is invisible to the user, who sees the button do
  nothing. The deliberate exception is `refreshPreview()` in
  `web/src/phase1.ts`, which runs on every control change and only logs: a
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

The comments in the source are Spanish, and so are the comments in the
configuration files that sit next to the source (`Cargo.toml`,
`rust-toolchain.toml`, `rustfmt.toml`, `biome.jsonc`). The user interface
strings, the error messages that reach the user, the README, the commit
messages and the whole of `.github/workflows/ci.yml` are English.

## 7) Evidence

- `rust-core/src/api.rs`, `rust-core/src/sheet.rs`, `rust-core/src/scanproc.rs`
- `rust-core/Cargo.toml` (`[lints]`), `rust-core/rustfmt.toml`, `rust-toolchain.toml`
- `web/biome.jsonc`, `web/package.json` (`lint`, `lint:fix`, `format`)
- `web/src/pool.ts`, `web/src/worker.ts`, `web/src/ui.ts`, `web/src/main.ts`
- `.github/workflows/ci.yml`, `.git-blame-ignore-revs`
