/**
 * Shield Packs (pure registry + detectors) tests.
 *
 * No DOM, no storage, no network: every function under test is pure, so this
 * runs as a plain `node --test` file. The canvas UI layer is deliberately not
 * exercised here (it is DOM-only); what is pinned below is the contract the UI
 * depends on, especially the fail-closed posture of the justice pack and the
 * "no em dash in user-visible copy" rule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIELD_PACKS_VERSION,
  listPacks,
  getPack,
  detectPatterns,
  scanColumnSamples,
  posture,
  postureCopy,
  DataGlowShieldPacks,
} from '../js/intelligence/shield-packs.js';

const EM_DASH = '—';

describe('shield-packs: module shape', () => {
  it('exports a version and the full public API on the namespace object', () => {
    assert.equal(SHIELD_PACKS_VERSION, 1);
    for (const fn of ['listPacks', 'getPack', 'detectPatterns', 'scanColumnSamples', 'posture', 'postureCopy']) {
      assert.equal(typeof DataGlowShieldPacks[fn], 'function', `missing ${fn}`);
    }
  });
});

describe('shield-packs: registry', () => {
  it('lists four packs with PHI as pack zero', () => {
    const packs = listPacks();
    assert.equal(packs.length, 4);
    assert.equal(packs[0].id, 'healthcare-phi');
    assert.equal(packs[0].index, 0);
    assert.equal(packs[0].engine, 'phi-shield');
    assert.equal(packs[0].flag, 'phiShield');
    assert.deepEqual(packs.map((p) => p.id), [
      'healthcare-phi', 'finance-pii', 'privilege', 'justice-cjis',
    ]);
  });

  it('keeps pack zero delegating to the PHI Shield rather than carrying its own detectors', () => {
    assert.deepEqual(getPack('healthcare-phi').detectorIds, []);
  });

  it('returns copies so callers cannot mutate the registry', () => {
    const first = listPacks();
    first[0].name = 'mutated';
    first[1].detectorIds.push('injected');
    const second = listPacks();
    assert.equal(second[0].name, 'Healthcare PHI');
    assert.ok(!second[1].detectorIds.includes('injected'));
  });

  it('returns null for an unknown pack id', () => {
    assert.equal(getPack('nope'), null);
    assert.equal(getPack(undefined), null);
  });

  it('declares no em dash in any pack summary', () => {
    for (const p of listPacks()) assert.ok(!p.summary.includes(EM_DASH), p.id);
  });
});

describe('shield-packs: detectPatterns', () => {
  it('flags SSN and EIN shapes for the finance pack', () => {
    const res = detectPatterns('member 123-45-6789 filed under EIN 12-3456789', 'finance-pii');
    const ids = res.findings.map((f) => f.id);
    assert.ok(ids.includes('ssn'));
    assert.ok(ids.includes('ein'));
    assert.ok(res.hitCount >= 2);
  });

  it('never returns the matched value, only counts', () => {
    const res = detectPatterns('123-45-6789', 'finance-pii');
    assert.ok(res.findings.length > 0);
    for (const f of res.findings) {
      assert.deepEqual(Object.keys(f).sort(), ['count', 'id', 'label', 'note']);
      assert.equal(typeof f.count, 'number');
    }
    assert.ok(!JSON.stringify(res).includes('123-45-6789'));
  });

  it('flags privilege wording case-insensitively', () => {
    const ids = detectPatterns('ATTORNEY-CLIENT privileged work product', 'privilege')
      .findings.map((f) => f.id);
    assert.deepEqual(ids, ['attorney-client', 'privileged', 'work-product']);
  });

  it('flags justice identifiers', () => {
    const ids = detectPatterns('Case No. CR-2024 charged under statute 187.2', 'justice-cjis')
      .findings.map((f) => f.id);
    assert.ok(ids.includes('case-number'));
    assert.ok(ids.includes('offense-code'));
  });

  it('does not leak detectors across packs', () => {
    assert.equal(detectPatterns('123-45-6789', 'privilege').hitCount, 0);
    assert.equal(detectPatterns('attorney-client', 'finance-pii').hitCount, 0);
  });

  it('runs every non-PHI detector when no pack is named', () => {
    const ids = detectPatterns('123-45-6789 attorney-client', undefined).findings.map((f) => f.id);
    assert.ok(ids.includes('ssn'));
    assert.ok(ids.includes('attorney-client'));
  });

  it('is reentrant: the same input gives the same result twice', () => {
    const a = detectPatterns('123-45-6789 and 234-56-7890', 'finance-pii');
    const b = detectPatterns('123-45-6789 and 234-56-7890', 'finance-pii');
    assert.deepEqual(a, b);
  });

  it('returns a safe empty result for non-strings, empty input, and unknown packs', () => {
    for (const bad of [null, undefined, 42, {}, [], '']) {
      assert.deepEqual(detectPatterns(bad, 'finance-pii'), { findings: [], hitCount: 0 });
    }
    assert.deepEqual(detectPatterns('123-45-6789', 'unknown-pack'), { findings: [], hitCount: 0 });
  });

  it('rejects impossible SSN area numbers so fewer ordinary numbers get flagged', () => {
    for (const impossible of ['987-65-4321', '000-12-3456', '666-12-3456', '123-00-4567', '123-45-0000']) {
      const ids = detectPatterns(impossible, 'finance-pii').findings.map((f) => f.id);
      assert.ok(!ids.includes('ssn'), impossible);
    }
  });

  it('leaves ordinary text alone', () => {
    assert.equal(detectPatterns('total revenue grew 12 percent', 'finance-pii').hitCount, 0);
  });
});

describe('shield-packs: scanColumnSamples', () => {
  const SAMPLES = {
    // Both values are SSN-shaped. 9xx area numbers are deliberately rejected by
    // the detector, so a second value like 987-65-4321 would NOT count as a hit.
    member_ssn: ['123-45-6789', '234-56-7890'],
    notes: ['routine follow up', 'no issues'],
    tax_id: [],
    amount: ['1200.50'],
  };

  it('flags columns by value pattern and by column-name hint', () => {
    const res = scanColumnSamples(SAMPLES, 'finance-pii');
    assert.deepEqual(res.flaggedColumns, ['member_ssn', 'tax_id']);
    const ssnCol = res.columns.find((c) => c.column === 'member_ssn');
    assert.ok(ssnCol.hits >= 2);
    assert.ok(ssnCol.detectors.some((d) => d.id === 'ssn'));
    const taxCol = res.columns.find((c) => c.column === 'tax_id');
    assert.equal(taxCol.hits, 0);
    assert.deepEqual(taxCol.nameHints, ['tax_id']);
  });

  it('never copies a sample value into the result', () => {
    const json = JSON.stringify(scanColumnSamples(SAMPLES, 'finance-pii'));
    assert.ok(!json.includes('123-45-6789'));
    assert.ok(!json.includes('routine follow up'));
  });

  it('returns nothing for the PHI pack, which the PHI Shield owns', () => {
    const res = scanColumnSamples(SAMPLES, 'healthcare-phi');
    assert.deepEqual(res.flaggedColumns, []);
    assert.equal(res.hitCount, 0);
  });

  it('returns a safe empty result for junk input', () => {
    for (const bad of [null, undefined, 'string', 7]) {
      const res = scanColumnSamples(bad, 'finance-pii');
      assert.deepEqual(res.columns, []);
      assert.equal(res.hitCount, 0);
    }
  });

  it('tolerates non-string cell values without throwing', () => {
    const res = scanColumnSamples({ mixed: [1, null, undefined, {}, '123-45-6789'] }, 'finance-pii');
    assert.ok(res.hitCount > 0);
  });
});

describe('shield-packs: posture', () => {
  it('is permissive with no pack active', () => {
    const p = posture({ activeIds: [] });
    assert.equal(p.level, 'standard');
    assert.equal(p.activeCount, 0);
    assert.equal(p.aiAllowed, true);
    assert.equal(p.exportAllowed, true);
    assert.equal(p.banner, false);
    assert.equal(p.onDevice, true);
    assert.equal(p.network, false);
  });

  it('fails closed on the justice pack: AI and export both blocked', () => {
    const p = posture({ activeIds: ['justice-cjis'] });
    assert.equal(p.level, 'maximum');
    assert.equal(p.aiAllowed, false);
    assert.equal(p.exportAllowed, false);
    assert.equal(p.banner, true);
  });

  it('takes the strongest posture across packs, never the weakest', () => {
    const p = posture({ activeIds: ['finance-pii', 'justice-cjis'] });
    assert.equal(p.level, 'maximum');
    assert.equal(p.aiAllowed, false);
    assert.equal(p.exportAllowed, false);
  });

  it('lets finance run without blocking anything', () => {
    const p = posture({ activeIds: ['finance-pii'] });
    assert.equal(p.level, 'elevated');
    assert.equal(p.aiAllowed, true);
    assert.equal(p.exportAllowed, true);
    assert.equal(p.exportCaution, false);
  });

  it('raises an export caution and column tagging for the privilege pack', () => {
    const p = posture({ activeIds: ['privilege'] });
    assert.equal(p.exportAllowed, true);
    assert.equal(p.exportCaution, true);
    assert.equal(p.columnTagging, true);
  });

  it('drops unknown ids instead of downgrading the posture', () => {
    const p = posture({ activeIds: ['justice-cjis', 'not-a-pack', null] });
    assert.deepEqual(p.activeIds, ['justice-cjis']);
    assert.equal(p.aiAllowed, false);
  });

  it('is safe with no argument at all', () => {
    assert.equal(posture().activeCount, 0);
    assert.equal(posture({}).aiAllowed, true);
  });
});

describe('shield-packs: postureCopy', () => {
  it('never uses an em dash in user-visible copy', () => {
    for (const ids of [[], ['finance-pii'], ['privilege'], ['justice-cjis'], ['finance-pii', 'justice-cjis']]) {
      const copy = postureCopy(posture({ activeIds: ids }));
      for (const [key, value] of Object.entries(copy)) {
        assert.equal(typeof value, 'string');
        assert.ok(!value.includes(EM_DASH), `em dash in ${key} for ${ids.join('+')}`);
        assert.ok(value.length > 0, `empty ${key}`);
      }
    }
  });

  it('pluralises the active count and states the blocked paths plainly', () => {
    assert.equal(postureCopy(posture({ activeIds: [] })).title, 'No pack active');
    assert.equal(postureCopy(posture({ activeIds: ['finance-pii'] })).title, '1 pack active');
    assert.equal(
      postureCopy(posture({ activeIds: ['finance-pii', 'privilege'] })).title,
      '2 packs active',
    );
    const blocked = postureCopy(posture({ activeIds: ['justice-cjis'] }));
    assert.match(blocked.ai, /blocked/);
    assert.match(blocked.exportLine, /blocked/);
  });

  it('never claims certification', () => {
    const copy = postureCopy(posture({ activeIds: ['justice-cjis'] }));
    assert.match(copy.disclaimer, /Screening aid only/);
    assert.ok(!/certified|compliant\b/i.test(copy.disclaimer));
  });

  it('is safe with no argument', () => {
    assert.equal(postureCopy().title, 'No pack active');
  });
});
