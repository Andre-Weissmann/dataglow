# DATAGLOW Desktop Shell (Tauri v1)

An optional native desktop wrapper around the existing DATAGLOW static site,
built with [Tauri v1](https://v1.tauri.app/). It ships the exact same vanilla
ES-module app you get in a browser, packaged as a self-contained window with a
native title bar and app icon. There is **no** bundler, transpiler, or framework:
the shell serves the repository's own static files, staged verbatim (a plain
copy) into a local directory that Tauri packages into the window.

## What it is (and is not)

- **Is:** a thin native window that loads the existing site. Same code, same
  zero-server, zero-upload behaviour. The window has only the capabilities a
  normal browser tab already has.
- **Is not:** a re-platforming. No framework, no bundler, no Rust-side business
  logic, no native database, no filesystem bridge. The Rust entry point
  (`src-tauri/src/main.rs`) is the stock vanilla template — it opens the window
  and nothing else.

## Layout

| Path | Purpose |
| --- | --- |
| `src-tauri/tauri.conf.json` | Window, bundle, icon and allowlist config. |
| `src-tauri/Cargo.toml` | Rust crate manifest for the shell. |
| `src-tauri/src/main.rs` | Stock entry point; registers no commands. |
| `src-tauri/build.rs` | Standard `tauri_build::build()`. |
| `src-tauri/icons/` | App icons reused across platforms. |
| `scripts/stage-desktop-frontend.mjs` | Copies the site's runtime assets into `src-tauri/dist/`. |

### Why a staging copy (and not `distDir = "../"`)

The app's static files live at the repository root, but Tauri v1's CLI **refuses**
a `distDir` that contains a `node_modules` or `src-tauri` folder — it errors with
*"isolate your web assets on a separate folder."* So the shell cannot point
`distDir` straight at the root.

Instead, `scripts/stage-desktop-frontend.mjs` copies the site's runtime surface
— `index.html`, `manifest.webmanifest`, `sw.js`, and the `assets/`, `css/`,
`js/`, and `protocol/` directories — into `src-tauri/dist/`, and `distDir`/`devPath`
point there. It is a **plain file copy**: no bundling, transpiling, or
minification, so the bytes served in the window are byte-for-byte the files a
browser loads. The script is wired into `beforeBuildCommand` and
`beforeDevCommand` in `tauri.conf.json`, so it runs automatically before every
`tauri dev`/`tauri build`; its output (`src-tauri/dist/`) is gitignored. The
allowlist of staged entries is maintained by hand in that script — if the site
grows a new top-level runtime asset, add it there.

## Capability posture (deny-by-default)

The Tauri v1 allowlist is fully disabled — `tauri.allowlist.all = false` and no
individual API is turned on. That means the webview gets **no** native
filesystem, shell, process, HTTP-proxy, or dialog access; it is confined to what
a browser tab can already do. The site's own opt-in network calls (the CDN
runtimes it lazy-loads, and a user-initiated Databricks pull) are ordinary
webview `fetch`/`import()` requests and are unaffected by the allowlist, which
governs only Tauri's native command bridge. The content-security-policy is left
`null` here to preserve the site's existing runtime behaviour (WASM, workers,
blob URLs, CDN runtimes) unchanged; tightening it is a natural follow-up but
would need to be validated against every runtime the site loads.

## Building locally

```
npm run tauri:dev            # run the shell against the live site
npm run tauri:build          # produce release installers for the host OS
npm run tauri:build:debug    # fast debug build (what CI runs)
```

These invoke the Tauri CLI via `npx --yes @tauri-apps/cli@^1.6` (matching the
existing `sbom` script's `npx` pattern) so no new entry is added to
`package.json` dependencies or `package-lock.json`. A Rust toolchain
(`rustc`/`cargo`) and the platform's Tauri system prerequisites must be present.

`tauri:build` emits installers into `src-tauri/target/release/bundle/`:

- **macOS:** `.app` and `.dmg`
- **Windows:** `.msi` and NSIS `.exe`
- **Linux:** `.deb` and `.AppImage`

(exact set depends on the host OS you build on — Tauri v1 builds installers for
the current platform only).

## Legal, signing and distribution notes

This shell is **not** code-signed or notarized. For a real public v1 release:

- **macOS:** distributing outside the App Store without notarization means
  Gatekeeper shows a "cannot verify developer" warning and the user must
  right-click → Open. Notarization requires enrollment in the Apple Developer
  Program (about **US$99/year** at time of writing) plus a Developer ID
  certificate; you then sign the `.app`/`.dmg` and submit it to Apple's
  notary service. None of that is done here.
- **Windows:** an unsigned `.exe`/`.msi` runs, but Microsoft SmartScreen shows a
  "Windows protected your PC" prompt until the binary earns reputation or is
  signed with an OV/EV Authenticode certificate (a separate paid cert from a CA).
  This is a friction warning, not a hard block, so it does not prevent a v1
  release — it just looks alarming to first-run users.
- **Bundled third-party code:** the shell adds Rust crates (Tauri and its
  dependencies, all permissively licensed) at build time; it does not vendor or
  redistribute any new third-party source in this repository.

Do not describe the produced artifacts as "signed" or "notarized" — they are
neither. Signing is a deliberate, credential-holding release step that is out of
scope for this shell.

## Out of scope (intentionally)

Native SQLite via `tauri-plugin-sql`, the File System Access bridge, and mobile
(Android/iOS) targets are explicitly **not** included. They would each expand the
capability surface well beyond "a browser tab in a native window" and are left
for a future, separately-scoped effort.
