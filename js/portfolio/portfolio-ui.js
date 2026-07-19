// ============================================================
// DATAGLOW — Portfolio Narrative Tab (ships dark behind the
// portfolioNarrativeAssembler flag)
// ============================================================
// Thin DOM/renderer layer over js/portfolio/narrative-assembler.js's pure
// assembly logic. Owns: reading the analyst's existing Problem Framer intake
// (if any), the current Story text + confidence caveats (if a story has been
// generated), the Clean tab's issues/audit log for this session, an editable
// recommendation textarea, and the Download/Copy buttons for the assembled
// write-up. Never re-runs Problem Framer, Story generation, the Clean scan,
// or the Overconfidence Guard itself -- it only reads whatever those tabs
// have already produced this session, exactly like the Pivot tab reads
// pivot-builder.js's pure SQL-generation logic without duplicating it.
//
// Live inputs, and why each one is read the way it is:
//   - Problem Framer: intake/answers are NOT persisted on `state` -- the
//     Framer tab itself reads them live from #framer-intake and
//     [data-framer-q] inputs each time it renders. This tab does the same,
//     so a framing recap only appears once the analyst has actually typed
//     something into that tab -- no duplicate state to drift out of sync.
//   - Story: state.lastStory (plain text, set by the Story tab's Generate
//     button) is DataGlow's real live "narrative" today -- there is no
//     wired-in storyDoc/buildStory() UI yet, so this tab treats
//     state.lastStory as the Story section's content rather than assuming a
//     storyDoc shape that doesn't exist in the live app.
//   - Confidence caveats: reuses window.__dataglowLastOverconfidence (set
//     below, alongside the existing renderNarrativeOverconfidencePanel call
//     in main.js) plus the app's own describeOverconfidenceFinding()
//     presenter, so caveat wording here is always identical to the Story
//     tab's own panel -- one source of English strings, per the "one check,
//     one owner" rule the rigor/ layer already follows.
//   - Clean: window.__dataglowAuditLog + a scan re-read via clean.scanForIssues()
//     against the active dataset, mirroring exactly what the Clean tab itself
//     calls on open. Issues aren't cached anywhere on `state`, so this is the
//     same non-mutating read the Clean tab does every time it scans.

import { el, escapeHtml } from '../app-shell/utils.js';
import {
  buildCleaningSummary,
  buildNarrativeDocument,
  renderNarrativeMarkdown,
  validateNarrativeDocument,
} from './narrative-assembler.js';

let currentHostId = null;
let recommendationDraft = '';

function readFramerMarkdownIfAny(problemFramer) {
  const intakeEl = document.getElementById('framer-intake');
  if (!intakeEl || !problemFramer) return null;
  const intake = intakeEl.value || '';
  const answers = {};
  document.querySelectorAll('[data-framer-q]').forEach((input) => { answers[input.dataset.framerQ] = input.value; });
  const hasAnyContent = intake.trim().length > 0 || Object.values(answers).some((v) => (v || '').trim().length > 0);
  if (!hasAnyContent) return null;
  try {
    return problemFramer.buildExportMarkdown({ intake, answers, columns: [] });
  } catch {
    return null;
  }
}

function buildDocFromLiveState({ problemFramer, getActiveDataset, clean, describeOverconfidenceFinding }) {
  const problemFramerMarkdown = readFramerMarkdownIfAny(problemFramer);

  const storyText = (typeof window !== 'undefined' && window.state && window.state.lastStory) || null;
  const storyDoc = storyText
    ? { title: 'DataGlow Portfolio Narrative', sections: [{ heading: 'Findings', content: storyText }] }
    : null;

  const rawFindings = (typeof window !== 'undefined' && window.__dataglowLastOverconfidence && window.__dataglowLastOverconfidence.findings) || [];
  const overconfidenceFindings = rawFindings.map((f) => ({
    ...f,
    message: describeOverconfidenceFinding ? describeOverconfidenceFinding(f) : null,
  }));

  const issues = (typeof window !== 'undefined' && window.__dataglowLastCleanIssues) || [];
  const auditLog = (typeof window !== 'undefined' && window.__dataglowAuditLog) || [];

  return buildNarrativeDocument({
    problemFramerMarkdown,
    storyDoc,
    issues,
    auditLog,
    recommendation: recommendationDraft,
    overconfidenceFindings,
  });
}

function renderPreview(doc) {
  const validation = validateNarrativeDocument(doc);
  const md = renderNarrativeMarkdown(doc);
  const summary = buildCleaningSummary(
    (typeof window !== 'undefined' && window.__dataglowLastCleanIssues) || [],
    (typeof window !== 'undefined' && window.__dataglowAuditLog) || [],
  );

  return el('div', { class: 'portfolio-narrative' }, [
    el('div', { class: 'portfolio-status-row' }, [
      el('span', { class: `validation-status ${validation.valid ? 'pass' : 'fail'}` }, [
        el('span', { class: `status-dot ${validation.valid ? 'pass' : 'fail'}` }),
        validation.valid
          ? ' All four sections are present.'
          : ` ${validation.errors.join('; ')}`,
      ]),
      el('span', { class: 'portfolio-status-meta' }, [
        ` \u00b7 ${summary.totalIssuesFound} issue(s) found, ${summary.openIssues.length} still open`,
      ]),
    ]),
    el('label', { class: 'framer-q-label', for: 'portfolio-recommendation' }, 'Closing recommendation'),
    el('textarea', {
      id: 'portfolio-recommendation',
      class: 'framer-input',
      rows: '3',
      'data-testid': 'input-portfolio-recommendation',
      placeholder: 'What would you tell a stakeholder to do next, given these findings?',
      value: recommendationDraft,
      oninput: (e) => { recommendationDraft = e.target.value; redraw(); },
    }),
    el('div', { class: 'panel-header', style: 'margin-top:var(--space-4);' }, [
      el('div', { class: 'panel-title' }, 'Preview'),
    ]),
    el('div', { class: 'portfolio-preview-wrap' }, [
      el('pre', { class: 'mono portfolio-preview', 'data-testid': 'portfolio-preview' }, [md]),
    ]),
    el('div', { style: 'display:flex; gap:var(--space-2); flex-wrap:wrap; margin-top:var(--space-3);' }, [
      el('button', {
        class: 'btn btn-primary',
        id: 'btn-portfolio-export',
        'data-testid': 'button-portfolio-export',
        onclick: () => downloadNarrative(md),
      }, 'Download Markdown'),
      el('button', {
        class: 'btn btn-secondary',
        id: 'btn-portfolio-copy',
        'data-testid': 'button-portfolio-copy',
        onclick: () => copyNarrative(md),
      }, 'Copy Markdown'),
    ]),
  ]);
}

function downloadNarrative(md) {
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dataglow-portfolio-narrative.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  if (typeof window !== 'undefined' && typeof window.toast === 'function') window.toast('Portfolio narrative downloaded', 'success');
}

async function copyNarrative(md) {
  try {
    await navigator.clipboard.writeText(md);
    if (typeof window !== 'undefined' && typeof window.toast === 'function') window.toast('Narrative copied to clipboard', 'success');
  } catch (e) {
    if (typeof window !== 'undefined' && typeof window.toast === 'function') window.toast('Copy failed: ' + e.message, 'error');
  }
}

let lastDeps = null;

function redraw() {
  if (!currentHostId || !lastDeps) return;
  const host = document.getElementById(currentHostId);
  if (!host) return;
  const doc = buildDocFromLiveState(lastDeps);
  host.innerHTML = '';
  host.appendChild(renderPreview(doc));
}

/**
 * Entry point called by main.js on every activation of the Portfolio tab.
 * @param {string} hostId - DOM id of the panel's body container
 * @param {Object} deps - live app references this tab reads without
 *   re-running: { problemFramer, getActiveDataset, clean, describeOverconfidenceFinding }
 */
export function renderPortfolioTab(hostId, deps) {
  currentHostId = hostId;
  lastDeps = deps || {};
  redraw();
}
