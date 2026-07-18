# Capability detail — MCP (Model Context Protocol) interface

Companion to the **MCP (Model Context Protocol) interface** area in
[`../capability-map.md`](../capability-map.md). Load this only when you're working
on the outward-facing MCP slice; the index alone is enough for most tasks.

## What this area is

Batch 4 (final) of the AI Readiness Gate line. It takes the gate logic already
built in Batches 1–3 and exposes it to any external MCP-compatible agent (Claude
Code, Cursor, Windsurf). It invents **zero new validation logic** — the MCP layer
is a thin typed adapter that composes `computeReadinessGate` / `explainGateReasons`
from `../../js/gate/readiness-gate.js` (Batch 1) and `evaluateAgentReadiness` from
`../../js/gate/agent-gate.js` (Batch 3). Two files make up the area:

- `../../js/mcp/dataglow-mcp-server.mjs` — the Node.js stdio MCP server (not browser code).
- `../../js/mcp/gate-state-exporter.js` — the browser-side serializer that produces the
  JSON snapshot the server reads.

## The bridge: how data crosses from browser to server

There is no live connection. The browser app serializes its gate state to a file
on disk; the server reads that file on every request. The contract file is
`dataglow-gate-state.json` (exported constant `GATE_STATE_FILENAME`), resolved by
the server at `GATE_STATE_PATH` = project root (`resolve(__dirname, '..', '..')`).

`gate-state-exporter.js` is pure (no DOM, no engine — Node-testable like all gate
modules) and exports:

- `GATE_STATE_VERSION` — currently `1`; bump if the shape changes.
- `buildGateStatePayload(datasets)` — takes an array of dataset descriptors
  `{ name, table, rowCount, cols:[{name,type}], layerResults, metricContractStatus? }`
  and returns `{ version, exportedAt (ISO), datasets }`. Defensively coerces every
  field (bad/missing entries are dropped via `.filter(Boolean)`; non-arrays yield an
  empty `datasets`).
- `serializeGateState(datasets)` — `JSON.stringify(buildGateStatePayload(...), null, 2)`.
- `GATE_STATE_FILENAME` — `'dataglow-gate-state.json'`.

## The server surface

`dataglow-mcp-server.mjs` builds an SDK `Server` (`name: 'dataglow'`,
`version: '1.0.0'`) over `StdioServerTransport`, declaring `tools`, `resources`,
and `prompts` capabilities. Gate state is re-read on every request via
`loadGateState()` (no in-memory cache); `getDatasets`, `findDataset`
(case-insensitive match on `name` OR `table`), and `computeForDataset` are the
internal helpers. `computeForDataset(ds)` runs `computeReadinessGate` with
`{ threshold: DEFAULT_THRESHOLD }` (70, from `readiness-gate.js`) plus
`evaluateAgentReadiness`, returning `{ gate, evaluation }`.

**Tool — `check_readiness`** (the only tool). Optional `dataset` arg (name or
table). With no arg it returns a summary of every dataset
(`agentConsumable`, `score`, `threshold`, `failingLayerCount`). With an arg it
returns the full verdict: `agentConsumable`, `score`, `threshold`,
`evaluatedLayerCount`, `blockedByContract`, `passingSummary`, `failingLayers`,
`reasons` (via `explainGateReasons`, only when not consumable), and a plain-language
`instruction`. `isError` is set true when the dataset is unknown or not consumable.

**Resources** — two per dataset, URIs shaped `dataglow://<type>/<name>` built by
`buildResourceUri`:
- `dataglow://schema/<name>` — `{ name, table, rowCount, columns:[{name,type}] }`.
- `dataglow://validation/<name>` — gate summary plus the raw `layerResults`.

`readResource` parses the URI with `/^dataglow:\/\/(schema|validation)\/(.+)$/`,
throws on an unknown URI or missing dataset.

**Prompts** — two templates (`PROMPTS`):
- `analyze_validated_dataset` — builds an analysis brief (schema line, readiness
  score, agent-consumable flag; adds a soft warning line when no layers fail but
  `score < 90`; a hard WARNING block when not consumable).
- `fix_failing_layers` — builds a remediation brief enumerating each failing
  layer and asking for meaning / root cause / SQL fix / verification. Returns a
  "no remediation needed" message when nothing fails.

**Fail-open fallback:** if no gate state file exists, every handler returns an
honest `no_validation_run` / "no gate state found" response (with
`agentConsumable: false`) rather than crashing. `server.connect(transport)` then
logs to `stderr` (never stdout, to keep the MCP channel clean).

## UI wiring

The `.mjs` server has **no** `main.js` wiring — it is a standalone process run
manually (`node js/mcp/dataglow-mcp-server.mjs`) and configured in a client's MCP
config. The only browser-side wiring is in `../../js/app-shell/main.js` (~line 8646),
gated on `isEnabled('mcpInterface')`: it reveals the Settings `#mcp-export-section`,
renders copy-paste Claude/Cursor config snippets, and binds `#btn-export-gate-state`
to serialize `state.datasets` (merged with `state.lastLayerResults`) and download
`dataglow-gate-state.json`. Note the export handler calls
`window.__dataglow_mcp_exporter__.serializeGateState`, but that global is only
*read* here — no assignment to it was found in the tree, so it currently relies on
the inline fallback (`JSON.stringify({ version: 1, ... })`) unless something else
populates the global.

## Gate flag and ship status

Gated by the `mcpInterface` flag in `../../flags.manifest.json`:
**`enabled: false`** (added in PR `feat/mcp-batch4-gate-server`). Ships **dark
behind the flag** on the browser side: the flag gates only the Settings "Export
Gate State" button that writes the file. Per the flag description, the MCP server
process itself is always runnable via `node js/mcp/dataglow-mcp-server.mjs`
regardless of flag state — but with the flag off, no dataset can produce the state
file through the UI, so in practice the round trip is dark until the flag flips ON.

## Tests

- `../../test/mcp-server.test.mjs` — the one matching suite. Calls the server's
  tool/resource/prompt handlers directly with mock gate state (no subprocess, no
  stdio, no file I/O) and exercises `gate-state-exporter`'s `buildGateStatePayload`
  / `serializeGateState`. Run with `node test/mcp-server.test.mjs`.

## Related files not in scope

- `../../js/gate/readiness-gate.js` — `computeReadinessGate`, `explainGateReasons`,
  `DEFAULT_THRESHOLD` (70). Batch 1 core the server wraps.
- `../../js/gate/agent-gate.js` — `evaluateAgentReadiness`. Batch 3.
- `../../js/app-shell/main.js` — the Settings-tab export button wiring described above.
