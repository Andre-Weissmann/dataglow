# Desktop llama.cpp sidecar: fetch path

The Tauri desktop shell can run a llama.cpp server as a sidecar process
(`tauri.bundle.externalBin`) instead of the browser's WebGPU model. Tauri
resolves each `externalBin` entry to a file named for the target triple at
**bundle time**, and gets the name wrong silently if you hand-place a binary
yourself. `js/ai/llama-sidecar-packaging.js` owns the naming and the agreement
checks; `scripts/fetch-llama-sidecar.mjs` is the one command that uses it to
put a binary in the right place with the right name.

## What this is not

- Not a downloader. It does not fetch a llama.cpp release for you. A release
  asset is tens of megabytes, the URL shape changes between releases, and
  guessing a URL is not something a build script should do quietly. Get a
  binary yourself (a release build, or `cmake --build ... --target
  llama-server`), then hand it to this script with `--from`.
- Not a model downloader either. A model is hundreds of megabytes and every
  model has its own licence; choosing one is a decision this script has no
  business making for anyone.
- Not something CI runs. Downloading a binary on every build to prove a naming
  convention is a poor trade; the convention is proven by a unit test instead
  (`npm run test:bundle14ledgerpqarrow`, and the packaging tests already
  shipped in Bundle 12/13).
- Not a committer. `src-tauri/binaries/` is listed in `.gitignore`. Nothing
  this script produces is ever committed, and no binary of any kind should be.

## Usage

```sh
# What would happen, with nothing written to disk:
node scripts/fetch-llama-sidecar.mjs --stub --dry-run
node scripts/fetch-llama-sidecar.mjs --from ./llama-server --dry-run

# See every target triple and whether a binary is vendored for it:
node scripts/fetch-llama-sidecar.mjs --list

# One-line status for the host triple: missing | fetched_unwired | ready
node scripts/fetch-llama-sidecar.mjs --status

# Local development placeholder that deliberately fails a handshake, so a
# status built against it stays honest rather than reporting ready:
node scripts/fetch-llama-sidecar.mjs --stub
node scripts/fetch-llama-sidecar.mjs --stub --triple aarch64-apple-darwin

# Place a real binary you already obtained:
node scripts/fetch-llama-sidecar.mjs --from ./llama-server --triple x86_64-unknown-linux-gnu

# Confirm tauri.conf.json and the vendored binaries agree with each other:
node scripts/fetch-llama-sidecar.mjs --check
```

Or via npm:

```sh
npm run fetch:llama-sidecar -- --list
npm run fetch:llama-sidecar -- --stub --dry-run
```

## The three-state fetch status

`--status` (and `fetchSidecarStatus()` in
`js/ai/llama-sidecar-packaging.js`) reports one of:

| State | Meaning |
|---|---|
| `missing` | No binary on disk for this triple. |
| `fetched_unwired` | A binary is vendored, but `tauri.bundle.externalBin` does not declare it yet (or the two disagree in a way `checkPackagingAgreement()` catches). A desktop build would either fail (declared without a file) or silently ship without the sidecar (vendored without a declaration). |
| `ready` | Vendored, declared, and the packaging agreement holds. This is about **packaging**, not about the server answering a request; a real handshake result is reported separately by `buildDesktopLlmStatus()` in `js/ai/desktop-local-llm.js`, and that status is the one that ever says the sidecar is usable. |

## Committing to shipping it

1. Run `node scripts/fetch-llama-sidecar.mjs --from <path> --triple <triple>`
   for **every** target triple this build actually ships.
2. Add `"binaries/llama-server"` to `tauri.bundle.externalBin` in
   `src-tauri/tauri.conf.json`.
3. Flip `bundledInThisBuild` in `js/ai/desktop-local-llm.js` in the same
   change, so the status module and the config cannot disagree.
4. Run `node scripts/fetch-llama-sidecar.mjs --check` and confirm it exits 0.

Until all four of those are true, the committed, honest state is: externalBin
empty, no binary vendored, sidecar status `sidecar_missing` /
`missing`. That state is intentional, is covered by tests, and CI's
packaging-agreement check fails if the two halves of it ever drift apart.

## Licence

llama.cpp is MIT. A model is not covered by that, and every model has its own
terms, so vendoring weights is a separate decision this path deliberately does
not make for you.
