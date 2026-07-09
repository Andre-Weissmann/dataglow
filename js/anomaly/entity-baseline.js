// ============================================================
// DATAGLOW — Per-Entity Baselining (UEBA-style)
// Flags values that are abnormal for THAT entity, not the global column.
// ============================================================

// User and Entity Behavior Analytics (UEBA) baselining — a general
// cybersecurity industry practice, NIST CSF-aligned. Each entity (vendor,
// customer, account…) gets its own mean/stddev, so we can catch a $12,000
// invoice from a vendor whose invoices normally run $200–800, even though
// $12,000 might look fine against the whole column.

export async function computeEntityBaselines(table, entityCol, valueCol, engine) {
  const { rows } = await engine.runQuery(
    `SELECT "${entityCol}" AS entity,
            AVG("${valueCol}") AS mean,
            STDDEV_POP("${valueCol}") AS stddev,
            COUNT("${valueCol}") AS n
     FROM ${table}
     WHERE "${valueCol}" IS NOT NULL
     GROUP BY "${entityCol}"`
  );
  const baselines = {};
  for (const r of rows) {
    baselines[String(r.entity)] = {
      mean: r.mean,
      stddev: r.stddev,
      n: r.n,
    };
  }
  return baselines;
}

export async function flagEntityDeviations(table, entityCol, valueCol, baselines, engine) {
  const { rows } = await engine.runQuery(
    `SELECT "${entityCol}" AS entity, "${valueCol}" AS value
     FROM ${table}
     WHERE "${valueCol}" IS NOT NULL`
  );
  const flags = [];
  for (const r of rows) {
    const base = baselines[String(r.entity)];
    if (!base || base.stddev == null || base.stddev === 0) continue;
    const value = Number(r.value);
    if (!Number.isFinite(value)) continue;
    const z = (value - base.mean) / base.stddev;
    if (Math.abs(z) > 3) {
      flags.push({
        entity: r.entity,
        value,
        entityMean: base.mean,
        entityStddev: base.stddev,
        zScore: Number(z.toFixed(2)),
        reason: `Value ${value} deviates ${z.toFixed(1)}σ from this entity's own baseline (mean ${Number(base.mean).toFixed(2)}, σ ${Number(base.stddev).toFixed(2)}).`,
      });
    }
  }
  flags.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  return flags;
}
