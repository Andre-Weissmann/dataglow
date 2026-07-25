# Publishing `canvas/index.html`

`canvas/index.html` is the single-file web surface, and it is **authoritative**.
It is not built from `src/` any more: features land by inlining a `js/` module
straight into its one big `<script>` behind
`/* ---- from <path> ---- */` ... `/* ---- end <path> ---- */` markers, using
that feature's `inject_*.py` script. `src/js/bundle.js` is a stale legacy
snapshot, so a rebuild from `src/` would silently drop every injected feature.
`build.sh` refuses to write the canvas unless `ALLOW_CANVAS_REBUILD` is set,
which is the guard against exactly that.

This page is the short list of what to check before that file is published, and
what each failure means. The gate that enforces most of it is
`scripts/check-canvas-integrity.mjs` (`npm run check:canvas-integrity`), which
runs in CI.

## Landing a feature in the canvas

1. Write the feature as a module under `js/`. Pure engine and canvas UI stay in
   separate files, so the engine can be tested without a browser.
2. Write `inject_<feature>.py` next to the other inject scripts. Copy the shape
   of an existing one rather than inventing a new convention:
   - the pure engine's ESM `export` keywords are stripped and the body is
     wrapped in an outer IIFE that attaches its namespace to `window`;
   - the canvas UI is already an IIFE carrying its own markers, so it is inlined
     verbatim;
   - the block goes in at a stable anchor, and the script aborts if the markers
     are already present, so running it twice cannot duplicate the feature.
3. **Never write a literal `</script>` into the block.** The canvas is one big
   inline `<script>`; a literal closing tag ends it early and truncates the rest
   of the page. Sources write `<\/script>`. `inject_notebook_app.py` refuses to
   inject a block containing one, which is a cheap thing to copy.
4. Run the inject script once, then immediately:

   ```sh
   npm run check:canvas-integrity            # parses every inline <script>
   ```

5. Add both new modules to `tracked` in `canvas/integrity.manifest.json` with a
   short `note`, then re-record the hashes and the file size:

   ```sh
   npm run check:canvas-integrity -- --update
   ```

   Review that diff like code. A hash change you cannot explain is the signal.

6. Register the feature so the repo stays honest about itself:
   - a flag in `flags.manifest.json` (with `description` and `flagOffBehavior`);
   - a record in `capability-map.manifest.json`, whose `files` must all exist
     (`npm run check:capability-map` fails otherwise, including on tests you
     have not written yet);
   - a row in `docs/capability-map.md`;
   - `test:<feature>` scripts in `package.json`, and a job that runs them in one
     of `.github/workflows/job-ci-batch-0X.yml`. A browser proof goes in
     `job-e2e-smoke.yml` instead, since that is the job with real Chrome. A
     feature whose tests no job runs is only tested on the machine that wrote it.

## Before publishing

| Check | Command | What a failure means |
| --- | --- | --- |
| Every inline `<script>` parses | `npm run check:canvas-integrity` | The canvas is broken for every user. Do not publish. |
| Tracked modules match their `js/` sources | same | A module was edited without re-injecting (or the inlined copy was hand-edited). Desktop and web would behave differently. |
| The whole file is the recorded size | same | `canvasBytes` mismatch. If you did not just inject on purpose, treat the canvas as truncated or as the wrong artifact and **do not publish it**. Only checks 1 to 3 look at tracked spans, so this is the one guard that notices the rest of the file going missing. |
| Capability registry is honest | `npm run check:capability-map` | The map claims something ships that has no files, or a flag and a capability disagree. |
| The feature's own tests | `npm run test:<feature>` and its UI test | Self explanatory. |
| Desktop still ships the mirrored modules | `npm run check:canvas-integrity` | `scripts/stage-desktop-frontend.mjs` stopped staging `index.html` + `js/`, so the desktop shell would ship a different frontend from the canvas. |

## The two surfaces, and why they can drift

- The repo-root `index.html` loads `js/` as real ES modules. That is what
  `scripts/stage-desktop-frontend.mjs` copies into `src-tauri/dist/` for the
  Tauri desktop shell.
- `canvas/index.html` runs the **inlined copies** and does not load `js/` at
  run time.

So editing a module under `js/` changes desktop immediately and changes the
canvas not at all. Nothing about that is visible without the integrity gate,
which is why re-injecting and re-recording is not optional bookkeeping.

## If the gate fails and you believe the canvas is fine

Re-record deliberately and read the diff:

```sh
npm run check:canvas-integrity -- --update
git diff canvas/integrity.manifest.json
```

If that diff shows a size change or a hash change you cannot account for, the
canvas is the thing to fix, not the manifest.
