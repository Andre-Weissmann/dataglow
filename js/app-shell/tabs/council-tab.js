// ============================================================
// AI Council Tab (Phase 11 -- ships dark behind the aiCouncil flag)
// ============================================================
// Multi-Model AI Council: ask one analytical question, get parallel answers
// from OpenAI, Anthropic Claude, and Google Gemini, then see where they agree
// (consensus), where two of three agree (majority), and where they differ
// (contested). Primary use case is data questions, not general chat.
// PRIVACY: schema (column names + types) only, same guarantee as NL->SQL --
// no row data is ever sent to any of the three providers.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-25) — byte-for-byte identical
// behavior, only the file location changed.

import { state } from '../state.js';
import { toast } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import { mountCouncilUI } from '../../council/council-ui.js';
import { datasetsToSchemaContext, serializeSchemaForPrompt } from '../../nl-sql/schema-context.js';

let _councilMounted = false;

export function renderCouncilTab() {
  // council-body now lives inside the AI tab panel, not a standalone panel
  const host = document.getElementById('council-body');
  if (!host) return;
  if (!isEnabled('aiCouncil')) { host.innerHTML = ''; return; }
  if (_councilMounted) return; // mount once; switching modes re-shows the existing UI
  _councilMounted = true;

  mountCouncilUI({
    host,
    getSchemaContext: function() {
      const datasets = state.datasets || [];
      if (!datasets.length) return null;
      try {
        const ctx = datasetsToSchemaContext(datasets, 'healthcare');
        return serializeSchemaForPrompt(ctx);
      } catch (err) {
        return null;
      }
    },
    onToast: toast,
  });
}
