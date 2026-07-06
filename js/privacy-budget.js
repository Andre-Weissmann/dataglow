// ============================================================
// DATAGLOW — Anonymized Export with Privacy Budget
// Adds calibrated statistical noise to aggregate exports.
// ============================================================

// Laplace mechanism for differential privacy — Dwork, McSherry, Nissim,
// Smith 2006 (public academic research). Noise scale = sensitivity / epsilon.
// Lower epsilon (ε) = stronger privacy, less precision.

// Sample from a Laplace(0, scale) distribution via inverse-CDF sampling.
export function laplaceNoise(scale) {
  // u in (-0.5, 0.5]; sign(u) * ln(1 - 2|u|) gives the Laplace inverse CDF.
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

export function addPrivacyBudgetNoise(trueValue, sensitivity, epsilon) {
  if (epsilon <= 0) throw new Error('epsilon (ε) must be greater than 0.');
  const scale = sensitivity / epsilon;
  return trueValue + laplaceNoise(scale);
}

// Given aggregate stats {label: numericValue}, return a noised copy plus
// metadata. Sensitivity defaults to 1 (suitable for counts); callers with
// higher-sensitivity aggregates can scale their inputs accordingly.
export function anonymizeAggregateExport(aggregateStats, epsilon = 1.0) {
  if (epsilon <= 0) throw new Error('epsilon (ε) must be greater than 0.');
  const noised = {};
  for (const [label, value] of Object.entries(aggregateStats)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      noised[label] = addPrivacyBudgetNoise(value, 1, epsilon);
    } else {
      noised[label] = value;
    }
  }
  return {
    values: noised,
    epsilon,
    mechanism: 'Laplace',
    disclaimer: 'Aggregate values include statistical noise calibrated to the selected privacy budget (epsilon). Lower epsilon = more privacy, less precision.',
  };
}
