// ============================================================
// DATAGLOW — MCP Server (AI Readiness Gate Batch 4 of 4)
// ============================================================
// WHY THIS EXISTS (the North Star concept, batch 4):
// Batches 1-3 built the pure gate scorer, the UI badge, and the
// in-app agent hard-block. This batch is the outward-facing slice:
// an MCP (Model Context Protocol) server that lets ANY external AI
// agent — Claude Code, Cursor, Windsurf, or any MCP-compatible
// tool — query DataGlow's gate before acting on a dataset.
//
// WHAT THIS SERVER EXPOSES:
//   Tools     — callable functions: check_readiness (gate verdict)
//   Resources — readable data: schema + validation summary per dataset
//   Prompts   — structured templates: analyze_validated_dataset,
//               fix_failing_layers
//
// PROTOCOL: MCP stdio transport (the universal default — works with
// every MCP-compatible client via a single subprocess command).
//
// ARCHITECTURE: this server is a Node.js process, NOT browser code.
// It runs alongside DataGlow or standalone, reads gate state from a
// shared JSON file (dataglow-gate-state.json in the project root,
// written by the browser app when the user exports/shares their gate
// result), and wraps js/gate/readiness-gate.js's pure logic.
//
// ZERO NEW CHECKS: this module invents no new validation logic. It
// composes computeReadinessGate() / explainGateReasons() from Batch 1
// and evaluateAgentReadiness() from Batch 3 — the MCP layer is a thin
// typed adapter around already-tested gate code.
//
// PURE FALLBACK: if no gate state file is present, every tool/resource
// returns an honest "no validation run found" response instead of
// crashing — fail-open for the server, honest to the agent caller.
//
// USAGE (stdio, the standard MCP transport):
//   node js/mcp/dataglow-mcp-server.mjs
//
// Claude Code config (~/.claude.json):
//   {
//     "mcpServers": {
//       "dataglow": {
//         "command": "node",
//         "args": ["/path/to/dataglow/js/mcp/dataglow-mcp-server.mjs"]
//       }
//     }
//   }
//
// Cursor config (.cursor/mcp.json):
//   {
//     "mcpServers": {
//       "dataglow": {
//         "command": "node",
//         "args": ["/path/to/dataglow/js/mcp/dataglow-mcp-server.mjs"]
//       }
//     }
//   }

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeReadinessGate, explainGateReasons, DEFAULT_THRESHOLD } from '../gate/readiness-gate.js';
import { evaluateAgentReadiness } from '../gate/agent-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const GATE_STATE_PATH = resolve(PROJECT_ROOT, 'dataglow-gate-state.json');

const SERVER_NAME = 'dataglow';
const SERVER_VERSION = '1.0.0';

// ── Gate state I/O ────────────────────────────────────────────
// The browser app writes dataglow-gate-state.json when the user
// exports their gate result. This server reads it on every request
// so it always reflects the latest validation run — no in-memory
// cache that could go stale.
//
// Shape expected (all fields optional — server tolerates missing ones):
// {
//   datasets: [
//     {
//       name: string,          // human label
//       table: string,         // DuckDB table name
//       rowCount: number,
//       cols: [{name, type}],
//       layerResults: object,  // runAllLayers() output
//       metricContractStatus?: object
//     }
//   ],
//   exportedAt: string         // ISO timestamp
// }

async function loadGateState() {
  if (!existsSync(GATE_STATE_PATH)) return null;
  try {
    const raw = await readFile(GATE_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getDatasets(state) {
  if (!state || !Array.isArray(state.datasets)) return [];
  return state.datasets;
}

function findDataset(state, name) {
  const datasets = getDatasets(state);
  // Match by name or table (case-insensitive)
  const lower = (name || '').toLowerCase();
  return datasets.find(
    (d) => (d.name || '').toLowerCase() === lower || (d.table || '').toLowerCase() === lower
  ) || null;
}

// ── Gate computation ──────────────────────────────────────────

function computeForDataset(ds) {
  if (!ds) return null;
  const gate = computeReadinessGate(
    ds.layerResults || {},
    ds.metricContractStatus || null,
    { threshold: DEFAULT_THRESHOLD }
  );
  const evaluation = evaluateAgentReadiness({
    layerResults: ds.layerResults || {},
    metricContractStatus: ds.metricContractStatus || null,
  });
  return { gate, evaluation };
}

// ── Tool: check_readiness ─────────────────────────────────────

const CHECK_READINESS_TOOL = {
  name: 'check_readiness',
  description:
    'Check whether a DataGlow-validated dataset is safe for AI agents to use. ' +
    'Returns agentConsumable (boolean), a readiness score (0-100), the threshold, ' +
    'any failing validation layers with reasons, and a human-readable summary. ' +
    'If agentConsumable is false, do NOT proceed with analysis — ask the user to ' +
    'fix the failing layers first. If no dataset name is given, returns a summary ' +
    'of all currently loaded datasets.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        description:
          'Dataset name or DuckDB table name to check. Omit to list all datasets and their readiness.',
      },
    },
    required: [],
  },
};

async function handleCheckReadiness(args) {
  const state = await loadGateState();

  if (!state) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'no_validation_run',
            message:
              'No DataGlow validation run found. Open DataGlow in your browser, load a dataset, ' +
              'run validation (Validate tab), then export the gate state via Settings > Export Gate State.',
            agentConsumable: false,
          }, null, 2),
        },
      ],
    };
  }

  const datasets = getDatasets(state);

  // No specific dataset requested — summarise all
  if (!args || !args.dataset) {
    const summary = datasets.map((ds) => {
      const result = computeForDataset(ds);
      const gate = result ? result.gate : null;
      return {
        name: ds.name || ds.table,
        table: ds.table,
        rowCount: ds.rowCount || 0,
        agentConsumable: gate ? gate.agentConsumable : false,
        score: gate ? gate.score : 0,
        threshold: gate ? gate.threshold : DEFAULT_THRESHOLD,
        failingLayerCount: gate ? gate.failingLayers.length : 0,
      };
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            datasetCount: datasets.length,
            exportedAt: state.exportedAt || null,
            datasets: summary,
          }, null, 2),
        },
      ],
    };
  }

  // Specific dataset requested
  const ds = findDataset(state, args.dataset);
  if (!ds) {
    const names = datasets.map((d) => d.name || d.table);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'dataset_not_found',
            message: `Dataset "${args.dataset}" not found in the gate state.`,
            availableDatasets: names,
            agentConsumable: false,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const result = computeForDataset(ds);
  const { gate, evaluation } = result;

  const response = {
    name: ds.name || ds.table,
    table: ds.table,
    rowCount: ds.rowCount || 0,
    exportedAt: state.exportedAt || null,
    agentConsumable: gate.agentConsumable,
    score: gate.score,
    threshold: gate.threshold,
    evaluatedLayerCount: gate.evaluatedLayerCount,
    blockedByContract: gate.blockedByContract,
    passingSummary: gate.passingSummary,
    failingLayers: gate.failingLayers,
    reasons: gate.agentConsumable ? null : explainGateReasons(gate),
    instruction: gate.agentConsumable
      ? 'This dataset has passed DataGlow validation. You may proceed with analysis.'
      : 'This dataset has NOT passed DataGlow validation. Do NOT proceed with analysis until the failing layers are resolved. See reasons and failingLayers for details.',
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
    isError: !gate.agentConsumable,
  };
}

// ── Resources ─────────────────────────────────────────────────

function buildResourceUri(type, datasetName) {
  return 'dataglow://' + type + '/' + datasetName;
}

async function listResources() {
  const state = await loadGateState();
  const datasets = getDatasets(state);
  const resources = [];
  for (const ds of datasets) {
    const name = ds.name || ds.table;
    resources.push({
      uri: buildResourceUri('schema', name),
      name: name + ' — schema',
      description: 'Column names, types, and row count for the "' + name + '" dataset.',
      mimeType: 'application/json',
    });
    resources.push({
      uri: buildResourceUri('validation', name),
      name: name + ' — validation summary',
      description: 'Full DataGlow validation layer results for the "' + name + '" dataset.',
      mimeType: 'application/json',
    });
  }
  return resources;
}

async function readResource(uri) {
  const state = await loadGateState();

  // Parse dataglow://<type>/<name>
  const match = uri.match(/^dataglow:\/\/(schema|validation)\/(.+)$/);
  if (!match) {
    throw new Error('Unknown resource URI: ' + uri);
  }
  const type = match[1];
  const name = decodeURIComponent(match[2]);
  const ds = findDataset(state, name);

  if (!ds) {
    throw new Error('Dataset "' + name + '" not found in gate state.');
  }

  if (type === 'schema') {
    const payload = {
      name: ds.name || ds.table,
      table: ds.table,
      rowCount: ds.rowCount || 0,
      columns: (ds.cols || []).map((c) => ({ name: c.name, type: c.type })),
    };
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  // type === 'validation'
  const result = computeForDataset(ds);
  const gate = result ? result.gate : null;
  const payload = {
    name: ds.name || ds.table,
    table: ds.table,
    agentConsumable: gate ? gate.agentConsumable : false,
    score: gate ? gate.score : 0,
    threshold: gate ? gate.threshold : DEFAULT_THRESHOLD,
    failingLayers: gate ? gate.failingLayers : [],
    passingSummary: gate ? gate.passingSummary : '',
    layerResults: ds.layerResults || {},
  };
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// ── Prompts ───────────────────────────────────────────────────

const PROMPTS = [
  {
    name: 'analyze_validated_dataset',
    description:
      'Returns a structured brief for an agent to analyze a DataGlow-validated dataset. ' +
      'Includes schema, readiness score, and any warnings — ready to paste before your analysis request.',
    arguments: [
      {
        name: 'dataset',
        description: 'Dataset name or table name to build the brief for.',
        required: true,
      },
    ],
  },
  {
    name: 'fix_failing_layers',
    description:
      'Returns a structured remediation brief for a dataset with failing validation layers. ' +
      'Lists each failing layer and what it means, suitable for asking an agent to suggest fixes.',
    arguments: [
      {
        name: 'dataset',
        description: 'Dataset name or table name with failing layers.',
        required: true,
      },
    ],
  },
];

async function getPrompt(name, args) {
  const state = await loadGateState();
  const datasetName = (args && args.dataset) || '';
  const ds = findDataset(state, datasetName);

  if (name === 'analyze_validated_dataset') {
    if (!ds) {
      return {
        description: 'DataGlow analysis brief',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                'No gate state found for dataset "' + datasetName + '". ' +
                'Please load and validate a dataset in DataGlow first.',
            },
          },
        ],
      };
    }

    const result = computeForDataset(ds);
    const gate = result ? result.gate : null;
    const cols = (ds.cols || []).map((c) => c.name + ' (' + c.type + ')').join(', ');
    const warningLines = gate && gate.failingLayers.length === 0 && gate.score < 90
      ? ['Note: some validation layers produced warnings — review before publishing results.']
      : [];

    const lines = [
      'You are analyzing a dataset that has been validated by DataGlow.',
      '',
      'Dataset: ' + (ds.name || ds.table),
      'Rows: ' + (ds.rowCount || 'unknown'),
      'Readiness score: ' + (gate ? gate.score : 'N/A') + ' / 100',
      'Agent-consumable: ' + (gate ? (gate.agentConsumable ? 'YES' : 'NO') : 'unknown'),
      '',
      'Schema:',
      cols || '(no columns found)',
      '',
    ].concat(warningLines);

    if (gate && !gate.agentConsumable) {
      lines.push(
        'WARNING: This dataset has NOT passed the AI Readiness Gate.',
        'Failing layers: ' + gate.failingLayers.map((l) => l.layer + ' — ' + l.reason).join('; '),
        'Do not draw conclusions until these are resolved.',
      );
    } else {
      lines.push(
        'This dataset has passed the AI Readiness Gate. Proceed with analysis.',
        gate ? gate.passingSummary : '',
      );
    }

    lines.push('', 'Please analyze this dataset and provide insights.');

    return {
      description: 'DataGlow analysis brief for ' + (ds.name || ds.table),
      messages: [
        { role: 'user', content: { type: 'text', text: lines.join('\n') } },
      ],
    };
  }

  if (name === 'fix_failing_layers') {
    if (!ds) {
      return {
        description: 'DataGlow remediation brief',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                'No gate state found for dataset "' + datasetName + '". ' +
                'Please load and validate a dataset in DataGlow first.',
            },
          },
        ],
      };
    }

    const result = computeForDataset(ds);
    const gate = result ? result.gate : null;
    const failing = gate ? gate.failingLayers : [];

    if (failing.length === 0) {
      return {
        description: 'DataGlow remediation brief — no failures',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                'Dataset "' + (ds.name || ds.table) + '" has no failing validation layers ' +
                '(score: ' + (gate ? gate.score : 'N/A') + '/100). No remediation needed.',
            },
          },
        ],
      };
    }

    const lines = [
      'The following DataGlow validation layers are failing for dataset "' + (ds.name || ds.table) + '".',
      'For each layer, suggest specific data remediation steps.',
      '',
      'Dataset: ' + (ds.name || ds.table),
      'Rows: ' + (ds.rowCount || 'unknown'),
      'Readiness score: ' + (gate ? gate.score : 'N/A') + ' / 100',
      '',
      'Failing layers:',
    ];

    for (const fl of failing) {
      lines.push('  - ' + fl.layer + ': ' + fl.reason);
    }

    lines.push(
      '',
      'For each failing layer above, provide:',
      '1. What this failure means in plain terms',
      '2. The most likely root cause in this type of dataset',
      '3. Specific SQL or data-cleaning steps to fix it',
      '4. How to verify the fix worked',
    );

    return {
      description: 'DataGlow remediation brief for ' + (ds.name || ds.table),
      messages: [
        { role: 'user', content: { type: 'text', text: lines.join('\n') } },
      ],
    };
  }

  throw new Error('Unknown prompt: ' + name);
}

// ── Server wiring ─────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [CHECK_READINESS_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'check_readiness') return handleCheckReadiness(args);
  return {
    content: [{ type: 'text', text: 'Unknown tool: ' + name }],
    isError: true,
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: await listResources(),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  return readResource(req.params.uri);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  return getPrompt(req.params.name, req.params.arguments);
});

// ── Start ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// Server is now running — communicates via stdin/stdout per MCP spec.
// stderr is available for debug logging without polluting the MCP channel.
process.stderr.write('DataGlow MCP server running (stdio transport)\n');
