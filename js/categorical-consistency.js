// ============================================================
// DATAGLOW — Categorical Consistency Engine (validation layer #16)
// Clusters near-identical spellings of the same category so that
// "France" / "FRA" / "French" are recognised as one thing, and proposes
// a canonical form (the most frequent variant) for a one-click merge.
// ============================================================

// String similarity uses only well-known public algorithms — Levenshtein
// (Levenshtein 1965) and Jaro-Winkler (Jaro 1989 / Winkler 1990) — via the
// existing implementations in fuzzy-dedup.js.
import { similarity } from './fuzzy-dedup.js';

const MAX_DISTINCT = 500; // clustering is O(n^2) on distinct values; cap for safety

// Legally/clinically sensitive category families. Textual similarity between
// values in these columns (e.g. "HISPANIC/LATINO - PUERTO RICAN" vs
// "HISPANIC/LATINO - CUBAN", or "Medicaid" vs "Medicare") is NOT evidence they
// are the same thing — they are distinct categories that materially affect
// equity and reimbursement analysis. Auto-merging them would corrupt real
// analysis, so merges are disabled on any column whose name matches.
const SENSITIVE_CATEGORY_NAME = /(race|ethnic|insurance|payer|payor|gender|religion|marital)/i;

export function isSensitiveCategory(columnName) {
  return SENSITIVE_CATEGORY_NAME.test(String(columnName ?? ''));
}

// A small, hand-maintained lookup of common ISO-3166 country and US state
// abbreviations mapped to their canonical long form. This is DATAGLOW's own
// short table (not a copied library) covering the abbreviations most likely
// to appear mixed with full names in business data.
const ABBREVIATION_MAP = {
  // ISO-3166 alpha-2 / alpha-3 country codes -> canonical name
  US: 'United States', USA: 'United States',
  UK: 'United Kingdom', GB: 'United Kingdom', GBR: 'United Kingdom',
  FR: 'France', FRA: 'France',
  DE: 'Germany', DEU: 'Germany', GER: 'Germany',
  ES: 'Spain', ESP: 'Spain',
  IT: 'Italy', ITA: 'Italy',
  NL: 'Netherlands', NLD: 'Netherlands',
  CA: 'Canada', CAN: 'Canada',
  MX: 'Mexico', MEX: 'Mexico',
  JP: 'Japan', JPN: 'Japan',
  CN: 'China', CHN: 'China',
  IN: 'India', IND: 'India',
  BR: 'Brazil', BRA: 'Brazil',
  AU: 'Australia', AUS: 'Australia',
  // US state postal codes -> canonical name (common subset)
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CO: 'Colorado', CT: 'Connecticut', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', IL: 'Illinois', MA: 'Massachusetts', MI: 'Michigan',
  NY: 'New York', NC: 'North Carolina', OH: 'Ohio', PA: 'Pennsylvania',
  TX: 'Texas', VA: 'Virginia', WA: 'Washington',
};

// Resolve a value to its canonical long form via the abbreviation table, if
// the whole (trimmed, upper-cased) value is a known code. Returns null if not.
export function expandAbbreviation(value) {
  if (value == null) return null;
  const key = String(value).trim().toUpperCase();
  return ABBREVIATION_MAP[key] || null;
}

// Two values are "abbreviation-equivalent" when one expands (via the lookup)
// to the other, compared case-insensitively.
function abbreviationEquivalent(a, b) {
  const ea = expandAbbreviation(a);
  const eb = expandAbbreviation(b);
  const la = String(a).trim().toLowerCase();
  const lb = String(b).trim().toLowerCase();
  if (ea && ea.toLowerCase() === lb) return true;
  if (eb && eb.toLowerCase() === la) return true;
  if (ea && eb && ea === eb) return true; // both codes for the same canonical
  return false;
}

// Union-find (disjoint set) — standard structure for grouping equivalences.
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  return { find, union };
}

// Cluster an array of { value, n } (value + occurrence count) into groups of
// near-identical spellings. Two values join a cluster when their string
// similarity exceeds `threshold` OR they are abbreviation-equivalent.
// The canonical form of each cluster is the most frequent variant.
export function clusterValues(valueFreqs, threshold = 0.82) {
  const items = valueFreqs.filter(v => v.value != null && String(v.value).trim() !== '');
  const uf = makeUnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = String(items[i].value);
      const b = String(items[j].value);
      if (a === b) continue;
      const sim = similarity(a.toLowerCase(), b.toLowerCase());
      if (sim >= threshold || abbreviationEquivalent(a, b)) {
        uf.union(i, j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }
  const clusters = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue; // a cluster needs at least 2 variants
    members.sort((a, b) => b.n - a.n);
    const canonical = members[0].value;
    clusters.push({
      canonical,
      variants: members.map(m => ({ value: m.value, count: m.n })),
      // merge mapping: every non-canonical variant -> the canonical spelling
      merges: members.slice(1).map(m => ({ from: m.value, to: canonical, count: m.n })),
    });
  }
  // Most-affected clusters first.
  clusters.sort((a, b) => b.variants.length - a.variants.length);
  return clusters;
}

// Query distinct value frequencies for one column and cluster them.
export async function detectColumnClusters(table, column, engine, options = {}) {
  const { rows } = await engine.runQuery(
    `SELECT "${column}" AS v, COUNT(*) AS n
     FROM ${table}
     WHERE "${column}" IS NOT NULL AND TRIM(CAST("${column}" AS VARCHAR)) <> ''
     GROUP BY 1
     ORDER BY n DESC
     LIMIT ${MAX_DISTINCT}`
  );
  const valueFreqs = rows.map(r => ({ value: String(r.v), n: Number(r.n) }));
  // Skip high-cardinality free-text columns — clustering names/notes/ids is noise.
  if (valueFreqs.length < 2 || valueFreqs.length > 200) return [];
  return clusterValues(valueFreqs, options.threshold);
}
