// ============================================================
// DATAGLOW — Confidence Score Per Cleaning Decision
// Pure function: rates how safe a proposed fix is. Does not modify clean.js.
// ============================================================

function label(score) {
  if (score >= 75) return 'High confidence';
  if (score >= 50) return 'Medium confidence';
  return 'Low confidence — review recommended';
}

// Heuristic fix-safety scoring. columnStats is an optional bag of stats the
// caller may supply, e.g. { cv, modeShare } where:
//   cv        = coefficient of variation (stddev/mean) for numeric columns
//   modeShare = fraction of non-null values equal to the mode (0..1)
export function scoreFixConfidence(issue, fixType, columnStats = {}) {
  let score = 60; // neutral default

  switch (fixType) {
    case 'trim':
      // Whitespace trimming is nearly always safe and reversible in intent.
      score = 96;
      break;
    case 'dedupe':
      score = 90;
      break;
    case 'abs_value':
      score = 55; // sign flips can be legitimate; moderate caution
      break;
    case 'null_out':
      score = 65;
      break;
    case 'fill_zero':
      // Filling with zero is a strong assumption unless the column is a count.
      score = /count|qty|quantity/i.test(issue.column || '') ? 70 : 45;
      break;
    case 'fill_mean': {
      const cv = columnStats.cv;
      if (cv == null) { score = 55; break; }
      // Low variance => mean is representative; high variance => unreliable.
      if (cv < 0.25) score = 80;
      else if (cv < 0.75) score = 60;
      else score = 45;
      break;
    }
    case 'fill_mode': {
      const share = columnStats.modeShare;
      if (share == null) { score = 55; break; }
      if (share >= 0.8) score = 88;      // dominant mode
      else if (share >= 0.5) score = 65; // majority
      else score = 42;                   // mere plurality — risky
      break;
    }
    case 'drop_rows':
      // Dropping rows loses data; safer when the affected fraction is tiny.
      score = (issue.pct != null && parseFloat(issue.pct) < 1) ? 70 : 50;
      break;
    default:
      score = 55;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, label: label(score) };
}
