// Command Deck, Part 2 -- global command palette (Ctrl/Cmd+K).
// ============================================================
// Pure logic only: no DOM, no globals, no keyboard listener here (that is
// main.js's job, same split as command-deck-nav.js in Part 1). This module
// answers two questions given a query string and the app's real state:
//   1. Which commands match, ranked best-first (buildCommandList + filterCommands)
//   2. What happens when a match is chosen (each command's `run` id + payload,
//      resolved by the caller -- this module never calls app functions itself)
//
// Two command families, matching the brainstorm report's Part 2 scope
// ("wired to jump to any of the 13 tools plus common in-tool actions"):
//   - "tab"    commands: jump to any real tab. Built from the caller's real
//              tabMeta (the same TAB_META main.js already has), so this can
//              never silently drift out of sync with the app's actual tool
//              list the way a hand-maintained duplicate list could -- same
//              drift-proofing discipline as Part 1's buildSidebarContent.
//   - "action" commands: a small, explicit static registry of common
//              in-tool actions (run query, run validation, export, etc.).
//              Each entry names a stable `run` id; main.js maps that id to
//              the real function call. This module holds no references to
//              runtime functions, so it stays pure and unit-testable.

/**
 * Static registry of common in-tool actions the palette can trigger.
 * `run` is a stable id the caller (main.js) switches on to invoke the real
 * function -- this module never calls anything itself. `whenTab` optionally
 * restricts a command to only be *offered* while that tab is active (e.g.
 * "Run query" only makes sense on the SQL tab); omit `whenTab` for an action
 * that makes sense from anywhere.
 * @type {Array<{id:string, label:string, run:string, whenTab?:string, keywords?:string[]}>}
 */
export const COMMAND_ACTIONS = [
  { id: 'action-run-sql', label: 'Run SQL query', run: 'runSqlQuery', whenTab: 'sql', keywords: ['execute', 'query'] },
  { id: 'action-run-validation', label: 'Run validation', run: 'runValidation', whenTab: 'validate', keywords: ['validate', 'check'] },
  { id: 'action-scan-clean', label: 'Scan for cleaning issues', run: 'scanClean', whenTab: 'clean', keywords: ['clean', 'fix', 'scan'] },
  { id: 'action-run-preflight', label: 'Run preflight checks', run: 'runPreflight', whenTab: 'preflight', keywords: ['preflight', 'check'] },
  { id: 'action-run-diagnostics', label: 'Run diagnostics', run: 'runDiagnostics', keywords: ['diagnostics', 'health'] },
  { id: 'action-export-xlsx', label: 'Export data as Excel workbook', run: 'exportXlsx', keywords: ['export', 'download', 'xlsx', 'excel'] },
];

/**
 * Build the full, real command list for the current app state: one "tab"
 * command per real tab (label/icon resolved from the caller's tabMeta, the
 * same object main.js already threads through everywhere), plus every
 * action command whose `whenTab` (if any) matches the currently active tab.
 * Pure -- takes real data in, returns a plain array out.
 *
 * @param {object} opts
 * @param {Record<string,{label:string, icon:string}>} opts.tabMeta the real TAB_META from main.js
 * @param {string[]} opts.tabOrder the real state.tabOrder (defines jump order)
 * @param {string} [opts.activeTab] the currently active tab id, for whenTab filtering
 * @returns {Array<{id:string, type:'tab'|'action', label:string, icon?:string, tabId?:string, run?:string}>}
 */
export function buildCommandList({ tabMeta, tabOrder, activeTab } = {}) {
  const meta = tabMeta || {};
  const order = Array.isArray(tabOrder) ? tabOrder : [];

  const tabCommands = order
    .filter(tabId => meta[tabId])
    .map(tabId => ({
      id: `tab-${tabId}`,
      type: 'tab',
      label: `Go to ${meta[tabId].label}`,
      icon: meta[tabId].icon,
      tabId,
    }));

  const actionCommands = COMMAND_ACTIONS
    .filter(a => !a.whenTab || a.whenTab === activeTab)
    .map(a => ({
      id: a.id,
      type: 'action',
      label: a.label,
      run: a.run,
      keywords: a.keywords || [],
    }));

  return [...tabCommands, ...actionCommands];
}

/**
 * Score how well a single command matches a query. Higher is better;
 * 0 (or below) means "no match, exclude it." Pure string logic, no DOM.
 * Matching rules, in priority order:
 *   - empty query matches everything, weakly (so the palette can show a
 *     full default list before the user types anything)
 *   - exact label match (case-insensitive) scores highest
 *   - label starts with query scores very high
 *   - label contains query as a substring scores high
 *   - a keyword contains the query scores medium
 *   - fuzzy: every character of the query appears in the label, in order
 *     (subsequence match), scores low but nonzero -- this is what lets
 *     "gt sql" style loose typing still find "Go to SQL"
 * @param {{label:string, keywords?:string[]}} command
 * @param {string} query
 * @returns {number}
 */
export function scoreCommand(command, query) {
  const q = (query || '').trim().toLowerCase();
  const label = (command.label || '').toLowerCase();
  if (!q) return 1;

  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (label.includes(q)) return 60;

  const keywords = command.keywords || [];
  if (keywords.some(k => k.toLowerCase().includes(q))) return 40;

  if (isSubsequence(q, label)) return 10;

  return 0;
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Filter and rank a command list against a query. Pure -- no DOM, no
 * mutation of the input array. Ties broken by original list order (stable).
 *
 * @param {Array<{label:string, keywords?:string[]}>} commands
 * @param {string} query
 * @param {number} [limit] max results to return (default: no limit)
 * @returns {Array} the matching commands, best match first
 */
export function filterCommands(commands, query, limit) {
  const list = Array.isArray(commands) ? commands : [];
  const scored = list
    .map((cmd, idx) => ({ cmd, idx, score: scoreCommand(cmd, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  const result = scored.map(({ cmd }) => cmd);
  return typeof limit === 'number' ? result.slice(0, limit) : result;
}
