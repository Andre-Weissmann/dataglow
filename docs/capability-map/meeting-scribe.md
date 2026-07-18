# Capability detail — Meeting scribe

Companion to the **Meeting scribe** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the Meeting tab / meeting-note path; the index alone is enough for most tasks.

## What this area is

The "analyst team goes to the meeting" capability: an analyst pastes (or, when
live capture is on, speaks) what was said in a meeting, and DataGlow grounds each
line against the chart that was on screen, flags stakeholder pushback and new
data requests, tracks action items under a strict resolved rule, and can persist
the noteworthy moments to a permanent on-device ledger. Every module here is
deterministic string/array logic — **no LLM, no server, no upload**; the only
network reference anywhere is the lazy CDN `import()` of the on-device STT runtime
in the live-capture module, which never routes audio off the machine.

Flags in this area (as currently found in `flags.manifest.json`):
- **`meetingScribe`** — `enabled: true` (promoted). The Meeting tab is live; when
  off, `renderTabBar()` omits `meeting` from `state.tabOrder` entirely.
- **`meetingDecisionLedger`** — `enabled: true` (promoted). A separate flag so the
  ledger can ship independently of the scribe.
- **`meetingScribeLiveCapture`** — `enabled: false` (**ships dark**, intentional
  per the Live Rooms batching plan). Gates the mic/STT input path only.

## `js/agents/meeting-scribe-agent.js` — Part 1: pure grounding/tagging

The pure core. `PUSHBACK_PHRASES`/`DATA_REQUEST_PHRASES` catalogs drive
`detectPushback(text)` and `detectDataRequest(text)` (substring match on a
normalized line). `tagSegmentsWithContext(segments, contextTimeline)` attaches to
each `{text, ts}` segment the last context event whose `ts <= segment.ts`
(segments before the first event get `context: null` — never guessed) plus its
pushback/dataRequest flags. `buildPushbackCandidate(segment)` shapes a segment
into a candidate for the existing on-device `resolve` (uncertainty-resolver-
agent.js) under a NEW `MEETING_PUSHBACK_CATEGORY = 'meeting-pushback'` chosen so
`resolve` falls through to the generic Step-C debate rather than a
hard-constraint fast path — and never invents a statistic. Action items:
`buildActionItem` starts every item `status:'open'`; `isActionItemResolved`
requires all three of owner+dueDate+outcome; `resolveActionItem` returns a NEW
item (never mutates) flipped to `resolved` only when the rule is met.
`buildMeetingNote(...)` rolls tagged segments into a JSON-safe note
(quoteCount/pushbackMoments/dataRequests/actionItems/chartsDiscussed) — building
only; signing/exporting is the export layer's job.

## `js/agents/meeting-scribe-ui.js` — Part 2: the Meeting tab

`shouldOfferMeetingScribe({ enabled })` is the pure gate the caller checks (the
module never reads the flag). `parseTranscriptText(raw)` splits pasted text into
`{text, ts}` (a leading integer is a seconds timestamp; a bare line auto-numbers
prev+1s). `mountMeetingScribe({ host, onToast, liveCapture, getContextTimeline })`
renders the textarea + Analyze/Clear, the grouped results (pushback / data
requests / all tagged lines), and the action-item tracker that only shows
"Resolved" when the rule passes. Each pushback line gets a **read-only**
"Re-check this number" action that runs `resolve(buildPushbackCandidate(segment))`
on-device and annotates the segment with a flat `recheckResolution` summary (four
scalars, not the full debate) that `getState()` exposes to the ledger. When
`liveCapture` is true it also renders Start/Stop capture controls. Returns
`{ destroy, getState }`.

## `js/agents/live-transcript-capture.js` — Live Rooms Batch 1: audio → segments

Pure/browser split mirroring `ondevice-llm.js`. Pure half:
`isSpeechCaptureAvailable()` (false unless BOTH getUserMedia AND WebGPU, never
throws); `assembleSegments(chunks)` and `createTranscriptAssembler()` turn raw STT
chunks (interim vs. `isFinal`) into the SAME `{text, ts}` shape
`parseTranscriptText` produces (interim discarded, empty dropped, missing ts
auto-numbered prev+1s). Browser-only half: `startLiveCapture(...)` wires
getUserMedia + a lazily-CDN-loaded WebGPU Whisper pipeline
(`STT_MODEL_ID = 'onnx-community/whisper-base'`, transformers.js), transcribing
rolling 5s windows entirely on-device. Gated by `meetingScribeLiveCapture`
(currently off).

## `js/agents/meeting-decision-ledger.js` — Part 3: append-only ledger (pure)

Takes Part 1's already-tagged output and turns noteworthy items into permanent,
JSON-safe entries. `buildLedgerEntry({ kind, meetingId, text, ts, context,
matched, status, actionFields, recheckResolution })` — append-only by design (a
resolution change is a NEW entry linked by `sourceKey`, never an in-place edit);
`recheckResolution` is defensively sanitized to four scalars with confidence
clamped 0–1. `buildLedgerEntriesFromMeeting(...)` keeps only pushback / data
requests / action items (or all lines with `includeAllLines`), sorted by ts.
Persistence is via an **injected store adapter** (`appendLedgerEntries` /
`getLedgerEntries` / `clearLedgerEntries`, the `js/learning/memory-store.js`
shape) — the module imports no storage engine. `saveLedgerEntries` /
`loadLedgerEntries`, pure `filterLedgerEntries` / `chartsReferencedIn`, and
`exportLedgerEntries` (formats a JSON string only — names no network primitive).

## `js/agents/meeting-decision-ledger-ui.js` — Part 3 presenter

`shouldOfferDecisionLedger({ enabled })` gate (separate `meetingDecisionLedger`
flag). `mountDecisionLedger({ host, store, getCurrentMeeting, onToast })` bolts a
section under the scribe screen: a [Save this meeting to ledger] button (nothing
auto-saves — reads `getCurrentMeeting()` = the scribe's `getState()`), a
read-only browse list with chart/kind filters, an [Export ledger (.json)]
client-side Blob download, and a confirm-gated [Clear ledger]. Returns
`{ destroy, refresh }`.

## Wiring in `main.js`

`renderMeetingScribeTab()` (line ~3547) gates on `isEnabled('meetingScribe')`,
then `mountMeetingScribe({ ..., liveCapture: isEnabled('meetingScribeLiveCapture'),
getContextTimeline: ... })`. The Decision Ledger mounts separately into
`#meeting-decision-ledger-body` gated on `isEnabled('meetingDecisionLedger')`.
The `getContextTimeline` supplier is the `chartContextTimeline` Live-Rooms module
documented in [`dataglow-rooms.md`](dataglow-rooms.md).

## Tests

- `test/meeting-scribe.test.mjs` — the Part 1 agent suite.
- `test/meeting-scribe-ui.test.mjs` — the Part 2 presenter suite.
- `test/live-transcript-capture.test.mjs` — the pure capture-assembly suite.
- `test/meeting-decision-ledger.test.mjs` — the Part 3 ledger core suite.
- `test/meeting-decision-ledger-ui.test.mjs` — the Part 3 presenter suite.

## Honest caveat — manifest area-name inconsistency

`capability-map.manifest.json` files these transcription modules under
`"area": "Meeting scribe"` (lowercase *s*), but two Live-Rooms bridge modules
(`js/agents/live-rooms-broadcast.js`, `js/agents/chart-context-timeline.js`) are
filed under a distinct `"area": "Meeting Scribe"` (capital *S*) string. Those two
are documented under [`dataglow-rooms.md`](dataglow-rooms.md); the capital-S
variant is a naming inconsistency, not a real separate area.
