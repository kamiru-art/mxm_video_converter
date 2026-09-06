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

The video path is separate and does not use the core: `web/src/video.ts` uses
WebCodecs through `mediabunny`, and falls back to `ffmpeg.wasm` when the
browser refuses a file.

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
| Poison flag | `web/src/worker.ts` and `web/src/pool.ts` | A Rust panic leaves the WebAssembly instance unusable, so the worker is marked and replaced when it goes idle. |
| Lazy respawn after a failure | `web/src/pool.ts` (`fail`, `MAX_BOOT_FAILURES`) | A worker that never replied did not start, usually because the tab is older than the deployed site and its hashed `worker-*.js` no longer exists. Respawning from `onerror` was a loop with no pause: one request to the origin per turn, and nothing visible to the user. Now the slot stays empty until the next `run()`, with a cap on attempts. |
| Command table | `web/src/worker.ts` (`handlers`) | One flat map from a command name to a core function. |
| Module-level singleton | `web/src/project.ts` | One shared project object, imported by every phase. |
| Adapter over storage | `web/src/store.ts` | Every read and write of `localStorage` is wrapped in `try`/`catch` in one place. |
| Explicit buffer transfer | `web/src/worker.ts` | Pixel buffers are moved between threads instead of copied. |
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
  `web/src/avi.ts` (ffmpeg.wasm) both produce frames, and the frame naming has
  to match between them, because the sheet labels depend on it.
- **The core is one crate.** `rust-core/src/sheet.rs` and `scanproc.rs` are
  about 50 KB each and hold the layout rules, the render and the scan
  pipeline together.

## 6) Evidence

- `web/src/main.ts`, `web/src/pool.ts`, `web/src/worker.ts`, `web/src/project.ts`
- `rust-core/src/api.rs`, `rust-core/src/lib.rs`
- `web/src/sw.ts`, `web/src/video.ts`, `web/src/avi.ts`
