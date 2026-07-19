# NATS WebSocket Bridge

## 1. What it is, and why it exists

The NATS WebSocket Bridge lets DataGlow subscribe to a **live event stream** —
published by a local [NATS](https://nats.io) server — and run every incoming
batch of messages through DataGlow's streaming validation pipeline, with
findings appearing in real time in the **Ambient Validation Rail**, all
without leaving the browser.

Today DataGlow already has two ways to validate data that arrives from
outside a file upload: [Validation Webhook Mode](webhook-mode.md) (a pipeline
pushes a batch via HTTP POST) and the streaming validator itself, which
underpins both. The NATS bridge adds a third: a **subscribe** model, suited to
telemetry, event buses, and pub/sub architectures where NATS is already the
transport of choice. A data engineer can point DataGlow at `metrics.>` on
their existing NATS deployment and watch schema drift, value drift, and
arrival anomalies surface live as messages flow, with zero pipeline code
changes on the publishing side.

Like the rest of DataGlow's real-time layers, this is **local-first**: the
NATS server runs on the user's own machine, the WebSocket connection never
leaves localhost by default, and no message payload is sent anywhere outside
the browser tab that opened the connection.

## 2. Architecture

```
[NATS Server (local, user's machine)]
    | WebSocket (ws://localhost:4222)
    v
[NATS WebSocket Client (browser)]
    | raw message bytes
    v
[nats-message-parser.js] --> parsed rows
    |
    v
[streaming-validator.js] --> validation snapshot
    |
    v
[nats-bridge.js] --> findings + rail update descriptor
    |
    v
[Ambient Validation Rail in Canvas]
```

Every box below the WebSocket client is **pure logic**: no network calls, no
storage access, no DOM. `js/nats/nats-message-parser.js` and
`js/nats/nats-bridge.js` never open a socket themselves — the browser (or a
test harness) is responsible for the actual `WebSocket` object and for
handing this module the bytes it receives. That is what makes the entire
bridge unit-testable under plain Node (see `test/nats/`).

## 3. NATS setup instructions

1. **Install NATS Server**
   - macOS: `brew install nats-server`
   - Other platforms: see the [official install docs](https://docs.nats.io/running-a-nats-service/introduction/installation)
2. **Start the server with the WebSocket interface enabled:**
   ```
   nats-server -p 4222 -m 8222 --websocket --websocket-port 4221
   ```
   - `-p 4222` — the standard NATS client port (unused by the browser bridge, but other NATS clients may still want it)
   - `-m 8222` — HTTP monitoring endpoint
   - `--websocket --websocket-port 4221` — the interface DataGlow actually connects to
3. **Publish a test message** (using the [NATS CLI](https://github.com/nats-io/natscli)):
   ```
   nats pub metrics.cpu '{"host": "web-01", "pct": 42.5}'
   ```
4. **Point DataGlow at the WebSocket port** — in the Canvas NATS setup UI, set
   the connection URL to `ws://localhost:4221` and the subject to subscribe
   to (e.g. `metrics.>`).

`generateConnectionGuide(config)` in `js/nats/nats-bridge.js` produces exactly
this four-step guide as a plain-text string, substituting the user's
configured subject and URL, for display inside the Canvas setup panel.

## 4. Supported message formats

`nats-message-parser.js` auto-detects the payload format of each incoming
message (or accepts an explicit `format` override):

| Format | Constant | Shape | Confidence |
|---|---|---|---|
| JSON | `NATS_FORMATS.JSON` | A single JSON object `{"col1": 1}` or a JSON array of objects `[{...}, {...}]` | High |
| NDJSON | `NATS_FORMATS.NDJSON` | One JSON object per line, newline-delimited | High |
| CSV line | `NATS_FORMATS.CSV_LINE` | A single delimited row, e.g. `"1,foo,3.5"` — headers are inferred (`col1`, `col2`, ...) unless supplied via `options.headers` | Medium (low if no delimiter found) |
| Protobuf stub | `NATS_FORMATS.PROTOBUF_STUB` | Placeholder for binary/Protobuf payloads — detected via UTF-8 decode failure, returned as a single `raw_base64` column | N/A — see Limitations |

Malformed lines or entries are **never fatal**: `parseNATSMessage` and
`parseNATSBatch` collect them into a `parseErrors` array and continue
parsing everything else in the payload/batch.

## 5. The batch model

NATS is a pub/sub firehose — messages can arrive far faster than it makes
sense to run a full validation pass per message. The bridge instead
**accumulates messages into batches** before validating, controlled by two
config values on `createNATSSession(config)`:

- `batchSize` (default `100`, valid range `1`–`10000`) — flush a batch once
  this many messages have accumulated.
- `batchIntervalMs` (default `1000`, valid range `100`–`60000`) — flush a
  batch after this many milliseconds even if `batchSize` hasn't been reached,
  so a slow subject doesn't leave the rail stale for the full window.

Whichever condition trips first flushes the batch: the browser wiring hands
the accumulated messages to `parseNATSBatch`, then the resulting rows to
`processBatch(session, rows, { runStreamingValidation })`. Both bounds are
validated up front by `validateNATSConfig`, so an invalid combination (e.g.
`batchSize: 50000`) is rejected before the bridge ever subscribes.

## 6. How findings surface in the Validation Rail

`processBatch` runs the batch through the streaming validator (injected, see
§8) and converts any drifted pillars — schema drift, value/mean-shift drift,
null spikes, arrival anomalies — into a flat list of `Finding` objects via
its internal `extractFindings` step. It then calls `buildRailUpdate` to
produce the `RailUpdate` descriptor the Canvas actually renders:

```js
{
  type: 'new_batch',
  batchNumber: 4,
  newFindings: [ /* Finding objects from this batch only */ ],
  totalFindings: 11,           // cumulative across the whole session
  toastMessage: 'New batch: 2 issues found.',
}
```

The `toastMessage` follows a fixed, testable format:
- `"New batch validated."` when the batch introduced no new findings.
- `"New batch: N issue found."` / `"New batch: N issues found."` (singular/plural) when it did.

The Canvas shows the toast immediately, then appends `newFindings` to the
Ambient Validation Rail's running list, keeping `totalFindings` as the badge
count.

## 7. Subject wildcard patterns

`buildSubjectFilter(pattern)` implements NATS's own subject wildcard rules
exactly, without depending on a NATS client library:

- **`*`** matches exactly one token (a token is the text between dots). e.g.
  `events.*.raw` matches `events.orders.raw` but not `events.orders.users.raw`
  or `events.raw`.
- **`>`** matches one or more trailing tokens, and must be the last token in
  the pattern. e.g. `metrics.>` matches `metrics.cpu` and
  `metrics.cpu.usage.pct`, but not bare `metrics` (there must be at least one
  trailing token) and not `other.cpu`.
- Any other token must match the corresponding subject token exactly.

This is used both to pre-filter which NATS subjects a session cares about and
to group/label incoming messages by subject in `parseNATSBatch`'s `subjects`
list.

## 8. Integration guide — how the Canvas wires the bridge

The bridge is intentionally transport-free and dependency-free of the
streaming validator. The Canvas (or any host) wires the three layers
together like this:

```js
import { validateNATSConfig, parseNATSBatch } from './js/nats/nats-message-parser.js';
import { createNATSSession, processBatch, summarizeNATSSession, resetBaseline } from './js/nats/nats-bridge.js';
import { runStreamingValidation } from './js/streaming/streaming-validator.js';

// 1. Validate the user's config before ever opening a socket.
const check = validateNATSConfig(config);
if (!check.valid) { /* show check.errors in the setup UI */ }

// 2. Create a session — pure state, no connection yet.
let session = createNATSSession(config);

// 3. The browser opens the actual WebSocket (ws://localhost:4221) and
//    accumulates raw messages until batchSize or batchIntervalMs trips.
//    (This part lives in the browser wiring, not in these modules.)

// 4. On each batch flush:
const { rows } = parseNATSBatch(accumulatedMessages);
const { session: nextSession, railUpdate } = processBatch(session, rows, {
  runStreamingValidation, // injected — no import coupling
});
session = nextSession;

// 5. Hand `railUpdate` to the Ambient Validation Rail (toast + list append),
//    and `summarizeNATSSession(session)` to the status bar / agent presence line.

// 6. If the user explicitly resets the drift anchor (e.g. "start fresh"):
session = resetBaseline(session);
```

This is the same dependency-injection pattern used by the proof-builder and
story-builder modules elsewhere in DataGlow: `processBatch` never imports
`streaming-validator.js` itself, so the bridge has zero import coupling and
stays trivially testable with a fake validator in Node.

## 9. Limitations

- **Browser WebSocket only.** The actual `WebSocket` connection is opened by
  the browser (or the Tauri desktop shell's WebView); these modules never
  open a socket themselves and have no Node-native WebSocket client.
- **No TLS in the stub.** The connection guide defaults to `ws://`, plaintext
  localhost. `wss://` is accepted by `validateNATSConfig`, but the bridge
  does no certificate handling of its own — that's entirely the browser's
  WebSocket implementation's responsibility.
- **Protobuf is a stub.** `NATS_FORMATS.PROTOBUF_STUB` payloads are detected
  (any payload that fails a clean UTF-8 decode) and surfaced as a single
  `raw_base64` column so the rest of the pipeline has something to validate,
  but there is no real Protobuf schema decoding yet. A future PR would add a
  `.proto`-aware decoder; today, base64 is the honest placeholder.
