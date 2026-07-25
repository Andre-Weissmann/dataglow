# Mobile QA checklist (narrow viewport, core analyst path)

## Why this document exists

Bundle 5 asked for the smallest real "B57". There is no B57 in this repository: there
is no B-series numbering anywhere in the docs, manifests or changelogs, and the
factory notes use "Batch". The spec says that in that case the honest deliverable is
a durable mobile QA artifact rather than a claim, so this checklist and
`test/mobile-viewport-smoke.test.mjs` are that artifact.

The two halves do different jobs and neither replaces the other:

- **The smoke test** catches the regressions a machine can see: sideways scroll,
  a control that shrank below a thumb, a surface that stopped mounting, a new
  network dependency. It runs on the real `canvas/index.html`, offline, in CI.
- **This checklist** covers what a machine cannot: whether the thing is usable.
  A 44px button in the wrong place still passes every assertion.

Run the checklist before shipping anything that touches layout, chrome or a panel.
Run the smoke test always.

## The automated half

```
npm run test:mobilesmoke        # node test/mobile-viewport-smoke.test.mjs
```

It loads the real canvas at 360px, 390px and 700px with every off-origin request
aborted, and fails on any of: a script throwing during boot, the document
scrolling sideways, Air-Gap / Trust / Explain not mounting, a visible control
under 44px, GlassBox missing from a result surface, an engine namespace not
published, or a new off-origin request. The three widths are the narrowest
Android still in wide use, the common iPhone class, and the house 700px
breakpoint itself where an off-by-one shows up.

Needs a Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if the bundled one
is not present.

## The manual half

Do this on a real phone if one is available, otherwise in device emulation at
390x844 with touch enabled. Emulation catches layout; only a real device catches
a button your thumb covers as you press it.

### Load and inspect

- [ ] The drop zone is reachable without pinching, and "Drop a file or browse"
      opens the system picker on the first tap.
- [ ] A loaded dataset shows column names that are readable, not clipped to
      ambiguity. Two columns whose visible text is identical is a failure.
- [ ] The table scrolls inside itself. If dragging the table drags the page
      sideways instead, that is the horizontal trap and it is a stop-ship.
- [ ] Rotating to landscape and back does not leave a panel half off screen.

### SQL and notebook lite

- [ ] The editor can be typed into without the keyboard hiding the Run button.
      If it does, the Run button needs to be reachable by one scroll, not by
      dismissing the keyboard.
- [ ] Run produces a result you can see without scrolling past a screen of
      chrome first.
- [ ] Long queries wrap in the GlassBox panel rather than scrolling sideways.
      This is asserted by the smoke test, but confirm it reads sensibly: a
      wrapped query should still be followable.

### Trust, Air-Gap, Explain

- [ ] Each button is hittable on the first attempt, three times in a row.
      A control that needs a second attempt is under-sized in practice even if
      it measures 44px.
- [ ] Trust panel: the Verify and Close controls stay reachable while scrolling a
      long chain. They are sticky by design; if they scroll away, the media query
      regressed.
- [ ] Air-Gap panel: turning the mode on and off is possible without the
      confirmation landing off screen.
- [ ] Explain panel: the whole explanation can be read by scrolling, the head and
      foot stay put, and Copy works.
- [ ] Escape or the Close button closes every panel. On a phone this is the only
      exit, so a panel that only closes by clicking outside itself is a trap.

### Save as app

- [ ] The confirm sheet is fully readable. This is the sheet where a person
      decides what leaves the device, so a line of it being off screen is a
      privacy problem and not a layout nit.
- [ ] Every checkbox in the sheet can be toggled by thumb.
- [ ] The Publish-Safe verdict is visible without scrolling, since it is the
      thing the sheet exists to communicate.

### PHI first run

- [ ] The first-run calm strip appears with no dataset loaded, and dismissing it
      keeps it dismissed after a reload.
- [ ] The PHI chip label is never blank and never clipped.

## When something fails

Fix the CSS in the `js/` module that owns the surface, not in `canvas/index.html`.
The canvas copy is regenerated: edit the source, re-run the module's
`inject_*.py`, then `npm run check:canvas-integrity -- --update`. Editing the
inlined copy directly makes desktop and web diverge, and the integrity check
fails on exactly that.

The house breakpoint is 700px. Use it rather than introducing a second one, so a
control does not change size twice on the way down from a tablet to a phone.
