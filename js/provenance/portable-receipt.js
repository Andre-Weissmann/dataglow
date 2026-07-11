// ============================================================
// DATAGLOW — Portable Receipts (DataGlow Passport, Batch B)
// ("Stamp lineage onto ONE exported artifact")
// ============================================================
// The whole-dataset Validation Receipt (js/provenance/validation-receipt.js) and
// the Selective-Disclosure Proof (js/provenance/selective-disclosure-proof.js)
// both travel as a full artifact ABOUT the dataset. The 2026 failure mode is
// smaller and more common: an analyst pastes ONE chart or ONE number into Slack
// or a slide deck, and every trace of where it came from is gone.
//
// A Portable Receipt is a lightweight, self-contained stamp for a SINGLE
// exported artifact (one chart export, one KPI/number, one exported table). It
// commits to, in one place anyone can re-check offline:
//   • the CLAIM it certifies (e.g. "SUM(revenue) for Q1 = 482,910"),
//   • a content HASH of the exact query / transform chain that produced it,
//   • the dataset's VALIDATION STATE (grade + summary) at compute time,
//   • a TIMESTAMP, and
//   • a verification fingerprint built with the SAME Merkle / SHA-256 primitives
//     as the selective-disclosure proof (imported, not reinvented).
//
// WHAT THIS ACTUALLY PROVES (precise, no overclaim — modeled on the honesty
// discipline in selective-disclosure-proof.js):
//   • It is a Merkle-tree (SHA-256, domain-separated leaves) commitment over the
//     receipt's own fields. Recomputing the tree from those fields reproduces the
//     committed root, so ANY partial edit — changing the displayed number,
//     swapping the query chain, back-dating the timestamp — breaks the match and
//     is detected by anyone, with only the receipt and no access to DATAGLOW.
// WHAT THIS IS NOT:
//   • It is NOT a signature or a zero-knowledge proof. There is no secret key; a
//     party willing to recompute EVERY field can produce a fresh, internally
//     consistent receipt. This is tamper-EVIDENCE that binds the fields of one
//     artifact together, not proof of authorship.
//   • It does NOT attest that the underlying number is correct, that the query
//     was appropriate, or that the data was compliant — only that these
//     committed values are internally consistent and unaltered since generation.
//   • Not a legal, clinical, or regulatory determination.
//
// buildClaimReceipt / verifyClaimReceipt are pure (no DOM, no network) and are
// the SAME logic the self-contained HTML verifier reruns client-side.

import { sha256Hex } from './provenance.js';
import { hashLeaf, buildMerkleTree } from './selective-disclosure-proof.js';
import { escapeHtml } from '../app-shell/utils.js';

export const PORTABLE_RECEIPT_KIND = 'dataglow-portable-receipt';
export const PORTABLE_RECEIPT_VERSION = 1;

export const PORTABLE_RECEIPT_DISCLAIMER =
  'This portable receipt is a Merkle-tree (SHA-256) commitment over its own '
  + 'fields: the certified claim, a content hash of the query/transform chain, '
  + 'the dataset validation state at compute time, and a timestamp. It lets '
  + 'anyone confirm OFFLINE that these values have not been altered since the '
  + 'receipt was generated. It is NOT a cryptographic signature and NOT a '
  + 'zero-knowledge proof — there is no secret key, so it proves internal '
  + 'consistency and tamper-evidence, not authorship. It does NOT certify that '
  + 'the underlying number is correct or that the data was compliant. Not a '
  + 'legal, clinical, or regulatory determination.';

// Normalize the caller's claim into a stable {label, value, statement} shape. A
// bare string is treated as the full statement; an object may supply any subset.
function normalizeClaim(claim) {
  if (claim == null) return { label: null, value: null, statement: '' };
  if (typeof claim === 'string') return { label: null, value: null, statement: claim };
  const label = claim.label ?? null;
  const value = claim.value ?? null;
  const statement = claim.statement
    ?? (label != null && value != null ? `${label} = ${value}` : (label ?? String(value ?? '')));
  return { label, value, statement };
}

// Deterministic serialization of the query/transform chain. The order the caller
// records IS the commitment — the verifier re-hashes exactly this.
function canonicalChain(chain) {
  return JSON.stringify(chain ?? null);
}
async function chainContentHash(chain) {
  return sha256Hex('QC:' + canonicalChain(chain));
}

// The ordered, fixed set of fields the Merkle tree commits to. Both build and
// verify derive leaves through THIS single function so they cannot drift. Each
// entry's {type, subject, value} is hashed with the shared hashLeaf primitive,
// so any change to a value changes its leaf and therefore the root.
function committedFields({ claimCanonical, queryChainHash, validationStateJson, datasetFingerprint, generatedAtISO }) {
  return [
    { label: 'Claim', type: 'claim', subject: null, value: claimCanonical },
    { label: 'Query/transform chain hash', type: 'query_chain_hash', subject: null, value: queryChainHash },
    { label: 'Validation state at compute', type: 'validation_state', subject: null, value: validationStateJson },
    { label: 'Dataset fingerprint', type: 'dataset_fingerprint', subject: null, value: datasetFingerprint ?? null },
    { label: 'Generated at', type: 'generated_at', subject: null, value: generatedAtISO },
  ];
}

// ------------------------------------------------------------
// Build a portable receipt for one exported artifact. Pure.
// ------------------------------------------------------------
export async function buildClaimReceipt({
  claim, queryOrTransformChain = null, validationStateAtCompute = null,
  datasetFingerprint = null, generatedAt = Date.now(),
} = {}) {
  const normClaim = normalizeClaim(claim);
  const generatedAtISO = new Date(generatedAt).toISOString();
  const queryChainHash = await chainContentHash(queryOrTransformChain);
  const validationStateJson = JSON.stringify(validationStateAtCompute ?? null);
  const claimCanonical = JSON.stringify(normClaim);

  const fields = committedFields({
    claimCanonical, queryChainHash, validationStateJson,
    datasetFingerprint: datasetFingerprint ?? null, generatedAtISO,
  });
  const leaves = await Promise.all(fields.map(hashLeaf));
  const tree = await buildMerkleTree(leaves);

  return {
    kind: PORTABLE_RECEIPT_KIND,
    version: PORTABLE_RECEIPT_VERSION,
    generatedAt: generatedAtISO,
    claim: normClaim,
    queryChain: queryOrTransformChain ?? null,
    queryChainHash,
    validationState: validationStateAtCompute ?? null,
    datasetFingerprint: datasetFingerprint ?? null,
    algorithm: 'Merkle tree (SHA-256, domain-separated leaves "L:" / nodes "N:") commitment over the receipt fields',
    commitment: {
      merkleRoot: tree.root,
      leafCount: fields.length,
      fields,
      leafHash: 'SHA-256 of "L:" + JSON({type,subject,value})',
      nodeHash: 'SHA-256 of "N:" + leftHex + rightHex',
    },
    shortCode: tree.root.slice(0, 8).toUpperCase(),
    disclaimer: PORTABLE_RECEIPT_DISCLAIMER,
  };
}

// ------------------------------------------------------------
// Independent verifier — takes ONLY the receipt. Pure.
// ------------------------------------------------------------
// Re-derives the committed field set from the receipt's own DISPLAY values,
// checks they match what the receipt committed to (partial-edit detection),
// re-hashes the query chain against its stored content hash, then rebuilds the
// Merkle root and compares it to the committed root.
export async function verifyClaimReceipt(model) {
  if (!model || model.kind !== PORTABLE_RECEIPT_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW portable receipt (missing/incorrect "kind").' };
  }
  const root = model.commitment && model.commitment.merkleRoot;
  if (!root) {
    return { valid: false, reason: 'Receipt has no committed Merkle root.' };
  }
  const stored = Array.isArray(model.commitment.fields) ? model.commitment.fields : [];

  const normClaim = normalizeClaim(model.claim);
  const expectedChainHash = await chainContentHash(model.queryChain ?? null);
  const expected = committedFields({
    claimCanonical: JSON.stringify(normClaim),
    queryChainHash: expectedChainHash,
    validationStateJson: JSON.stringify(model.validationState ?? null),
    datasetFingerprint: model.datasetFingerprint ?? null,
    generatedAtISO: model.generatedAt,
  });

  if (stored.length !== expected.length) {
    return { valid: false, reason: 'Committed field set size does not match the receipt contents.' };
  }
  for (let i = 0; i < expected.length; i++) {
    if (stored[i].type !== expected[i].type || stored[i].value !== expected[i].value) {
      return {
        valid: false,
        reason: `Receipt field "${expected[i].label}" does not match its committed value — it was altered after the receipt was generated.`,
      };
    }
  }
  if (model.queryChainHash !== expectedChainHash) {
    return {
      valid: false,
      reason: 'The query/transform chain does not match its committed content hash — the chain or its hash was altered.',
    };
  }

  const leaves = await Promise.all(stored.map(hashLeaf));
  const tree = await buildMerkleTree(leaves);
  if (tree.root !== root) {
    return { valid: false, reason: 'Recomputed Merkle root does not match the committed root — the receipt was tampered with.' };
  }

  return {
    valid: true,
    reason: `Verified — all ${stored.length} committed field(s) match the receipt fingerprint ${root.slice(0, 8).toUpperCase()}. `
      + '(Integrity / tamper-evidence check only — not a determination that the underlying number is correct.)',
  };
}

// ------------------------------------------------------------
// Opt-in gate — trust artifacts are opt-in and visible, NEVER silent.
// ------------------------------------------------------------
// The UI passes the checkbox state through here. A receipt is produced ONLY on a
// strict `attach === true`; any other value (false, undefined, a truthy string)
// yields null so a receipt can never be attached by accident.
export async function attachPortableReceiptIfRequested(attach, receiptInput) {
  if (attach !== true) return null;
  return buildClaimReceipt(receiptInput);
}

// Package the verifier HTML as a Universal Export Contract blob descriptor so it
// rides the existing deliverBlob() adapters as a second downloaded file.
export function receiptBlob(model, filenameStem) {
  const html = renderReceiptVerifierHTML(model);
  const stem = (filenameStem && String(filenameStem)) || 'dataglow-artifact';
  return {
    data: new TextEncoder().encode(html),
    filename: `${stem}.receipt.html`,
    mimeType: 'text/html',
  };
}

// ------------------------------------------------------------
// Self-contained offline HTML verifier
// ------------------------------------------------------------
// A single HTML file — inline styles, no external assets, no outbound request —
// that shows the claim and reruns the SAME verification client-side with an
// inline vanilla-JS verifier (crypto.subtle only). Anyone can open it in any
// browser, disconnected, and confirm the fingerprint. The inline verifier below
// mirrors verifyClaimReceipt; a portable artifact cannot import modules, so this
// duplication is inherent (the module stays the single source of truth for the
// algorithm, guarded by the unit tests).
const CARD_STATUS_COLOR = { ok: '#1a7f4b', bad: '#b3261e', pending: '#6b7280' };

function fieldRows(model) {
  const rows = [
    ['Claim', model.claim && model.claim.statement ? model.claim.statement : ''],
    ['Dataset validation state', model.validationState
      ? `Grade ${model.validationState.grade ?? '—'} · ${model.validationState.summary ?? ''}` : 'Not recorded'],
    ['Query / transform chain hash', model.queryChainHash || ''],
    ['Dataset fingerprint', model.datasetFingerprint || 'Not recorded'],
    ['Generated at', model.generatedAt ? new Date(model.generatedAt).toLocaleString() : ''],
  ];
  return rows.map(([k, v]) => `
        <tr>
          <td style="padding:8px 10px; border-bottom:1px solid #eceff3; font-weight:600; white-space:nowrap; color:#42505f; vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:8px 10px; border-bottom:1px solid #eceff3; color:#2a3542; word-break:break-all;">${escapeHtml(String(v))}</td>
        </tr>`).join('');
}

export function renderReceiptVerifierHTML(model) {
  const dt = model.generatedAt ? new Date(model.generatedAt).toLocaleString() : '';
  // Embed the model as JSON, neutralizing "</script>"-style breakouts.
  const embedded = JSON.stringify(model).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DATAGLOW Portable Receipt — ${escapeHtml(model.shortCode || '')}</title>
</head>
<body style="margin:0; padding:24px; background:#f4f6f9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1a2430;">
  <div style="max-width:720px; margin:0 auto; background:#fff; border:1px solid #e3e8ee; border-radius:14px; overflow:hidden; box-shadow:0 1px 3px rgba(16,24,40,0.06);">
    <div style="padding:22px 28px; background:linear-gradient(135deg,#1a2430,#2a3a52); color:#fff;">
      <div style="font-size:12px; letter-spacing:0.14em; text-transform:uppercase; opacity:0.75;">DATAGLOW · Portable Receipt</div>
      <div style="font-size:20px; font-weight:800; margin-top:4px;">${escapeHtml(model.claim && model.claim.statement ? model.claim.statement : 'Certified artifact')}</div>
      <div style="font-size:12px; opacity:0.7; margin-top:2px;">Fingerprint <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(model.shortCode || '')}</strong> · Generated ${escapeHtml(dt)}</div>
    </div>

    <div style="padding:24px 28px;">
      <div id="verdict" style="display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:10px; background:#f1f3f6; color:${CARD_STATUS_COLOR.pending}; font-weight:700; margin-bottom:22px;">
        <span style="font-size:20px;">⏳</span><span>Checking this receipt in your browser…</span>
      </div>

      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tbody>${fieldRows(model)}
        </tbody>
      </table>

      <div style="margin-top:22px; padding:14px 16px; background:#f8fafc; border:1px solid #e3e8ee; border-radius:10px; font-size:12px; color:#6b7280; line-height:1.55;">
        ${escapeHtml(model.disclaimer || '')}
      </div>
    </div>

    <div style="padding:14px 28px; background:#f8fafc; border-top:1px solid #e3e8ee; font-size:11px; color:#8a97a6;">
      This receipt verifies itself offline. The check below runs entirely in your browser with no network request.
    </div>
  </div>

<script>
(function () {
  var MODEL = ${embedded};
  var OK = ${JSON.stringify(CARD_STATUS_COLOR.ok)}, BAD = ${JSON.stringify(CARD_STATUS_COLOR.bad)};

  async function sha256Hex(str) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function canonicalClaimLeaf(f) {
    return JSON.stringify({ type: f.type, subject: f.subject == null ? null : f.subject, value: f.value == null ? null : f.value });
  }
  function hashLeaf(f) { return sha256Hex('L:' + canonicalClaimLeaf(f)); }
  function hashNode(l, r) { return sha256Hex('N:' + l + r); }
  async function merkleRoot(leaves) {
    if (!leaves.length) return sha256Hex('L:empty');
    var level = leaves.slice();
    while (level.length > 1) {
      var next = [];
      for (var i = 0; i < level.length; i += 2) {
        var left = level[i], right = i + 1 < level.length ? level[i + 1] : level[i];
        next.push(await hashNode(left, right));
      }
      level = next;
    }
    return level[0];
  }
  function normClaim(c) {
    if (c == null) return { label: null, value: null, statement: '' };
    if (typeof c === 'string') return { label: null, value: null, statement: c };
    var label = c.label == null ? null : c.label, value = c.value == null ? null : c.value;
    var statement = c.statement != null ? c.statement : (label != null && value != null ? (label + ' = ' + value) : (label != null ? label : String(value == null ? '' : value)));
    return { label: label, value: value, statement: statement };
  }
  function fieldsFrom(claimCanonical, chainHash, validationJson, fingerprint, generatedAtISO) {
    return [
      { label: 'Claim', type: 'claim', subject: null, value: claimCanonical },
      { label: 'Query/transform chain hash', type: 'query_chain_hash', subject: null, value: chainHash },
      { label: 'Validation state at compute', type: 'validation_state', subject: null, value: validationJson },
      { label: 'Dataset fingerprint', type: 'dataset_fingerprint', subject: null, value: fingerprint == null ? null : fingerprint },
      { label: 'Generated at', type: 'generated_at', subject: null, value: generatedAtISO }
    ];
  }

  async function verify(model) {
    if (!model || model.kind !== ${JSON.stringify(PORTABLE_RECEIPT_KIND)}) return { valid: false, reason: 'Not a DATAGLOW portable receipt.' };
    var root = model.commitment && model.commitment.merkleRoot;
    if (!root) return { valid: false, reason: 'Receipt has no committed Merkle root.' };
    var stored = Array.isArray(model.commitment.fields) ? model.commitment.fields : [];
    var nc = normClaim(model.claim);
    var expectedChainHash = await sha256Hex('QC:' + JSON.stringify(model.queryChain == null ? null : model.queryChain));
    var expected = fieldsFrom(JSON.stringify(nc), expectedChainHash, JSON.stringify(model.validationState == null ? null : model.validationState), model.datasetFingerprint == null ? null : model.datasetFingerprint, model.generatedAt);
    if (stored.length !== expected.length) return { valid: false, reason: 'Committed field set size mismatch.' };
    for (var i = 0; i < expected.length; i++) {
      if (stored[i].type !== expected[i].type || stored[i].value !== expected[i].value) {
        return { valid: false, reason: 'Field "' + expected[i].label + '" does not match its committed value.' };
      }
    }
    if (model.queryChainHash !== expectedChainHash) return { valid: false, reason: 'Query/transform chain does not match its committed content hash.' };
    var leaves = [];
    for (var j = 0; j < stored.length; j++) leaves.push(await hashLeaf(stored[j]));
    var recomputed = await merkleRoot(leaves);
    if (recomputed !== root) return { valid: false, reason: 'Recomputed Merkle root does not match the committed root.' };
    return { valid: true, reason: 'Verified — matches the committed fingerprint ' + root.slice(0, 8).toUpperCase() + '.' };
  }

  verify(MODEL).then(function (res) {
    var el = document.getElementById('verdict');
    if (res.valid) {
      el.style.color = OK; el.style.background = '#e7f5ec';
      el.innerHTML = '<span style="font-size:20px;">✅</span><span>Verified — matches the committed fingerprint</span>';
    } else {
      el.style.color = BAD; el.style.background = '#fdecea';
      el.innerHTML = '<span style="font-size:20px;">⚠️</span><span>Fingerprint mismatch — ' + res.reason + '</span>';
    }
  }).catch(function (e) {
    var el = document.getElementById('verdict');
    el.style.color = BAD; el.style.background = '#fdecea';
    el.innerHTML = '<span style="font-size:20px;">⚠️</span><span>Could not verify: ' + (e && e.message ? e.message : e) + '</span>';
  });
})();
</script>
</body>
</html>`;
}
