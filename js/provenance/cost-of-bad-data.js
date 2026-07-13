// ============================================================
// DATAGLOW — Live "$ cost-of-bad-data" quantifier
// ============================================================
// A deliberately transparent, client-side multiplication that turns a flagged-
// row count into a plainly-labelled dollar figure: N rows flagged × an editable
// per-error rework cost = an ESTIMATED amount at risk. It is surfaced after the
// Denial Root-Cause Profiler and (where a flagged count is available) after the
// existing validation run.
//
// It is NOT a prediction, a guarantee, or a DATAGLOW cost claim. There is no ML,
// no server call, and no hidden model — just `flaggedCount * perErrorCost`. The
// per-error cost is a USER-ADJUSTABLE ASSUMPTION with a placeholder default
// sourced from published claims-rework-cost research (see COST_SOURCE_NOTE); the
// user should replace it with their own figure. All wording uses "estimated
// risk", never "cost", so the number never reads as certain.

// Default placeholder: ~$118 to rework a single denied/defective claim, a figure
// commonly cited from healthcare revenue-cycle / claims-rework research (e.g.
// industry rework-cost-per-claim studies). It is an EDITABLE ASSUMPTION, not a
// measured DATAGLOW value — surface it as such wherever it appears.
export const DEFAULT_PER_ERROR_COST = 118;

export const COST_SOURCE_NOTE =
  'Default of $118 per flagged row is a placeholder drawn from published claims-rework-cost '
  + 'research and is meant to be edited to your own rework cost. It is an assumption you control, '
  + 'not a figure DATAGLOW measures or guarantees.';

function toNonNegativeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function formatMoney(amount, currency = 'USD') {
  const n = toNonNegativeNumber(amount, 0);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    // Unknown currency code — fall back to a plain, clearly-labelled number.
    return `${currency} ${Math.round(n).toLocaleString('en-US')}`;
  }
}

// The whole quantifier: a pure function of (flaggedCount, perErrorCost). Returns
// the inputs it used, the product, a human sentence, and the honesty disclaimer,
// so callers render a consistent, clearly-hedged estimate.
export function estimateCostOfBadData({ flaggedCount = 0, perErrorCost = DEFAULT_PER_ERROR_COST, currency = 'USD' } = {}) {
  const rows = Math.max(0, Math.trunc(toNonNegativeNumber(flaggedCount, 0)));
  const cost = toNonNegativeNumber(perErrorCost, DEFAULT_PER_ERROR_COST);
  const estimatedRiskAmount = rows * cost;
  const formatted = formatMoney(estimatedRiskAmount, currency);
  return {
    flaggedCount: rows,
    perErrorCost: cost,
    currency,
    isDefaultCost: cost === DEFAULT_PER_ERROR_COST,
    estimatedRiskAmount,
    formatted,
    editable: true,
    label: `${rows.toLocaleString('en-US')} row(s) flagged × ${formatMoney(cost, currency)} avg rework cost = ${formatted} estimated at risk`,
    sourceNote: COST_SOURCE_NOTE,
    disclaimer: 'Estimated risk only — a transparent client-side multiplication, not a prediction or a guaranteed cost. '
      + 'The per-error cost is an editable assumption you set; adjust it to your own rework cost.',
  };
}
