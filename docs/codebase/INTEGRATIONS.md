# External Integrations

The short version: at runtime this application integrates with almost nothing.
It has no backend, no database, no authentication and no telemetry. The
integrations below are for the build, for hosting, and for two assets the page
loads.

## 1) Integration Inventory

| System | Type | Purpose | Auth model | Criticality | Evidence |
|--------|------|---------|------------|-------------|----------|
| Cloudflare Workers | Static hosting | Serves the built site at `mxmstudio.work` (MXM Studio account), with the single-page-application fallback. `www.mxmstudio.work` is a zone Redirect Rule (301 to the apex, path and query kept) on a proxied placeholder record, set in the dashboard, not a Worker. | API token, held as a GitHub secret. | High: it is how the application reaches users. | `web/wrangler.jsonc`, `.github/workflows/ci.yml` |
| Cloudflare Workers, old address | Hand-over | `mxm.sebastianlopez.me` (Sebastián's own account) serves the last build published there with a "moved" page in place of `index.html`: it carries `localStorage` to the new address and retires the old service worker. Published by hand, never by CI. | Local `wrangler` login | Medium: links and installed apps from before the move go through it. | `deploy/old-domain/`, `web/src/migrate.ts` |
| GitHub Actions | CI/CD | Runs the Rust tests, builds the WebAssembly and the site, runs the browser test, deploys. | The workflow's own `GITHUB_TOKEN`, with `contents: read`. | High | `.github/workflows/ci.yml` |
| Google Fonts | Static asset over the network | Web fonts for the interface. | None | Low: the page still works without them. | `web/src/sw.ts` (`FONT_HOSTS`) |
| `ffmpeg.wasm` | Bundled asset, about 32 MB | Decodes what WebCodecs refuses (AVI, camera MOV in HEVC 10-bit or ProRes). The export no longer uses it. | None | Medium: without it, AVI files and some camera MOV files do not open. The lossless export does not depend on it. | `web/src/avi.ts`, `web/prepare-ffmpeg.mts` |
| Browser platform APIs | Runtime | WebAssembly, WebCodecs, WebGPU, Web Workers, `localStorage`, service worker, `createImageBitmap`. | None | High | `web/src/pool.ts`, `web/src/video.ts`, `web/src/webgpu.ts` |

There is **no** database, no message queue, no cache server, no e-mail
provider, no payment provider, no authentication provider, no error reporting
service and no analytics. A search of `web/src` finds no `fetch` to any
third-party API.

## 2) Data Storage

| Store | What it holds | Where it lives | Evidence |
|-------|---------------|----------------|----------|
| `localStorage`, one key `mxm-studio-v1` | The presets, the calibration profiles, and the last phase 1 settings. | The user's browser. | `web/src/store.ts` |
| `localStorage`, `mxm_ram_gb` and `mxm-migrated-ids` | The memory the user typed in phase 2; the ids of the old-address browsers whose data was already imported here. | The user's browser. | `web/src/phase2.ts`, `web/src/migrate.ts` |
| In-memory `project` object | The frames, the layout, the sheet images, the processed frames, the report. Lost on reload. | The tab. | `web/src/project.ts` |
| Cache Storage, three caches | The application shell, the hashed assets, the fonts. | The user's browser. | `web/src/sw.ts` |

Everything the user makes stays on the user's machine. The export and import
of profiles is a manual JSON file download and upload
(`web/src/phase3.ts`), not a synchronisation service.

`localStorage` belongs to one origin, so the move from `mxm.sebastianlopez.me`
to `mxmstudio.work` would have left every saved preset behind. The old
address now answers every page with `deploy/old-domain/index.html`, whose
script reads the store and the RAM setting, gives that browser an id
(`mxm-migration-id`, kept there) and navigates to
`https://mxmstudio.work/#mxm-migrate=<base64url JSON>`. The fragment is never
sent to a server, though it does reach the browser history for an instant;
it carries print and calibration settings, no personal data. `main.ts` calls
`runMigration()` (`web/src/migrate.ts`) before anything reads the route or
the store: it adds what arrives to what is already there
(`store.mergeFromOldAddress`; on a name clash the new address wins, and the
`flags` probe cache is not carried), restores the route of the old link
(`#scans`…), and records the id in `mxm-migrated-ids`, so a later visit
through an old bookmark does not bring back a preset deleted since, while a
migration link copied from somebody else does not block the user's own. If
the import fails, a toast that stays until clicked points to
`mxm.sebastianlopez.me/?export`, which offers the old store as a file for
*Import profiles* in Calibration; the same page offers the file when the
store is too large for a URL (over 900 kB: Firefox stops at 1 MiB).

The old app's service worker is not removed from the page: the browser
fetches the new `/sw.js` (`deploy/old-domain/sw.js`), which waits, like the
app's own, until the last tab of the old app closes, then deletes the old
caches and unregisters itself. An old tab open in the middle of a project
keeps its cached scripts until then.

## 3) Authentication and Authorization

None. There are no accounts, no sessions, no tokens and no roles, because
there is no server to authenticate against. The only credentials in the whole
system are the two CI secrets used to deploy.

## 4) Secrets and Configuration

| Name | Used by | Where it is stored | Evidence |
|------|---------|--------------------|----------|
| `CLOUDFLARE_API_TOKEN` | The deploy step; scoped to the MXM Studio account | GitHub repository secret | `.github/workflows/ci.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | The deploy step; the MXM Studio account | GitHub repository secret | `.github/workflows/ci.yml` |

The account id is deliberately absent from `web/wrangler.jsonc`: CI passes it
as a secret, and a local deploy exports `CLOUDFLARE_ACCOUNT_ID`. It is not a
credential, but a public repository has no reason to publish it.

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
- **`web/public/ffmpeg/` missing**: `web/src/avi.ts` fetches
  `manifest.json` without checking the response, so the failure appears as a
  confusing `SyntaxError` rather than a clear message. This is the state of a
  fresh clone under `npm run dev`. See `CONCERNS.md`.
- **WebCodecs absent or refusing a file**: the application falls back to
  `ffmpeg.wasm` (`web/src/video.ts`).
- **WebGPU absent**: the scans are straightened in WebAssembly instead
  (`web/src/webgpu.ts`, `web/src/phase2.ts`).

## 6) Evidence

- `.github/workflows/ci.yml`, `web/wrangler.jsonc`
- `web/src/store.ts`, `web/src/project.ts`, `web/src/sw.ts`
- `web/src/avi.ts`, `web/src/video.ts`, `web/src/webgpu.ts`
- `web/prepare-ffmpeg.mts`
