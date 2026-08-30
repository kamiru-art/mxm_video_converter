# External Integrations

The short version: at runtime this application integrates with almost nothing.
It has no backend, no database, no authentication and no telemetry. The
integrations below are for the build, for hosting, and for two assets the page
loads.

## 1) Integration Inventory

| System | Type | Purpose | Auth model | Criticality | Evidence |
|--------|------|---------|------------|-------------|----------|
| Cloudflare Workers | Static hosting | Serves the built site at `mxm.sebastianlopez.me`, with the single-page-application fallback. | API token, held as a GitHub secret. | High: it is how the application reaches users. | `web/wrangler.jsonc`, `.github/workflows/ci.yml` |
| GitHub Actions | CI/CD | Runs the Rust tests, builds the WebAssembly and the site, runs the browser test, deploys. | The workflow's own `GITHUB_TOKEN`, with `contents: read`. | High | `.github/workflows/ci.yml` |
| Google Fonts | Static asset over the network | Web fonts for the interface. | None | Low: the page still works without them. | `web/public/sw.js` (`FONT_HOSTS`) |
| `ffmpeg.wasm` | Bundled asset, about 32 MB | Decodes what WebCodecs refuses, and muxes the two MOV exports. | None | Medium: without it, AVI files and some camera MOV files do not open, and the MOV exports are unavailable. | `web/src/avi.js`, `web/prepare-ffmpeg.mjs` |
| Browser platform APIs | Runtime | WebAssembly, WebCodecs, WebGPU, Web Workers, `localStorage`, service worker, `createImageBitmap`. | None | High | `web/src/pool.js`, `web/src/video.js`, `web/src/webgpu.js` |

There is **no** database, no message queue, no cache server, no e-mail
provider, no payment provider, no authentication provider, no error reporting
service and no analytics. A search of `web/src` finds no `fetch` to any
third-party API.

## 2) Data Storage

| Store | What it holds | Where it lives | Evidence |
|-------|---------------|----------------|----------|
| `localStorage`, one key `mxm-studio-v1` | The presets, the calibration profiles, and the last phase 1 settings. | The user's browser. | `web/src/store.js` |
| In-memory `project` object | The frames, the layout, the sheet images, the processed frames, the report. Lost on reload. | The tab. | `web/src/project.js` |
| Cache Storage, three caches | The application shell, the hashed assets, the fonts. | The user's browser. | `web/public/sw.js` |

Everything the user makes stays on the user's machine. The export and import
of profiles is a manual JSON file download and upload
(`web/src/phase3.js`), not a synchronisation service.

## 3) Authentication and Authorization

None. There are no accounts, no sessions, no tokens and no roles, because
there is no server to authenticate against. The only credentials in the whole
system are the two CI secrets used to deploy.

## 4) Secrets and Configuration

| Name | Used by | Where it is stored | Evidence |
|------|---------|--------------------|----------|
| `CLOUDFLARE_API_TOKEN` | The deploy step | GitHub repository secret | `.github/workflows/ci.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | The deploy step | GitHub repository secret | `.github/workflows/ci.yml` |

The account id is also written in `web/wrangler.jsonc`, so the repository
holds a copy of it. An account id is not a credential, and it is useless
without the token, but the committed copy is redundant because CI passes the
secret. `[ASK USER]` — see the question in the summary.

If `CLOUDFLARE_API_TOKEN` is absent, the workflow prints a warning, marks the
deploy as skipped and stays green. A repository that is recreated therefore
builds and tests correctly while silently not publishing until both secrets
are set again.

## 5) Failure Modes

- **Cloudflare unreachable at deploy time**: the workflow fails at the last
  step; the site keeps serving the previous version.
- **Google Fonts unreachable**: the interface falls back to the local font
  stack. The service worker serves the fonts from its cache after the first
  visit.
- **`web/public/ffmpeg/` missing**: `web/src/avi.js` fetches
  `manifest.json` without checking the response, so the failure appears as a
  confusing `SyntaxError` rather than a clear message. This is the state of a
  fresh clone under `npm run dev`. See `CONCERNS.md`.
- **WebCodecs absent or refusing a file**: the application falls back to
  `ffmpeg.wasm` (`web/src/video.js`).
- **WebGPU absent**: the scans are straightened in WebAssembly instead
  (`web/src/webgpu.js`, `web/src/phase2.js`).

## 6) Evidence

- `.github/workflows/ci.yml`, `web/wrangler.jsonc`
- `web/src/store.js`, `web/src/project.js`, `web/public/sw.js`
- `web/src/avi.js`, `web/src/video.js`, `web/src/webgpu.js`
- `web/prepare-ffmpeg.mjs`
