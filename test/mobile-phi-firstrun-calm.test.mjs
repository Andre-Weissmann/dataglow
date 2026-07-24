/**
 * Mobile-safe PHI chip + first-run calm (pure helper) tests.
 * No DOM required; a fake Web Storage is injected for the first-run marker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOBILE_PHI_FIRSTRUN_CALM_VERSION,
  FIRST_RUN_STORAGE_KEY,
  isFirstRun,
  markFirstRunSeen,
  chipLabel,
  shouldShowCalmStrip,
  calmCopy,
  DataGlowMobilePhiFirstRunCalm,
} from '../js/intelligence/mobile-phi-firstrun-calm.js';

// Minimal in-memory Web Storage stand-in.
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => map,
  };
}

const EM_DASH = '—';

describe('mobile-phi-firstrun-calm: module shape', () => {
  it('exports a version and a stable default storage key', () => {
    assert.equal(MOBILE_PHI_FIRSTRUN_CALM_VERSION, 1);
    assert.equal(typeof FIRST_RUN_STORAGE_KEY, 'string');
    assert.ok(FIRST_RUN_STORAGE_KEY.length > 0);
  });

  it('bundles all public fns on the namespace object', () => {
    assert.equal(typeof DataGlowMobilePhiFirstRunCalm.isFirstRun, 'function');
    assert.equal(typeof DataGlowMobilePhiFirstRunCalm.markFirstRunSeen, 'function');
    assert.equal(typeof DataGlowMobilePhiFirstRunCalm.chipLabel, 'function');
    assert.equal(typeof DataGlowMobilePhiFirstRunCalm.shouldShowCalmStrip, 'function');
    assert.equal(typeof DataGlowMobilePhiFirstRunCalm.calmCopy, 'function');
    assert.equal(DataGlowMobilePhiFirstRunCalm.FIRST_RUN_STORAGE_KEY, FIRST_RUN_STORAGE_KEY);
  });
});

describe('mobile-phi-firstrun-calm: first-run marker', () => {
  it('reports first run when storage is empty', () => {
    const s = fakeStorage();
    assert.equal(isFirstRun('k1', s), true);
  });

  it('markFirstRunSeen persists and flips isFirstRun to false', () => {
    const s = fakeStorage();
    assert.equal(markFirstRunSeen('k1', s), true);
    assert.equal(isFirstRun('k1', s), false);
  });

  it('uses the default key when none is passed', () => {
    const s = fakeStorage();
    markFirstRunSeen(undefined, s);
    assert.equal(isFirstRun(undefined, s), false);
    assert.notEqual(s.getItem(FIRST_RUN_STORAGE_KEY), null);
  });

  it('keys are independent', () => {
    const s = fakeStorage();
    markFirstRunSeen('a', s);
    assert.equal(isFirstRun('a', s), false);
    assert.equal(isFirstRun('b', s), true);
  });

  it('fails open to first-run when no storage is reachable', () => {
    assert.equal(isFirstRun('k', null), true);
    assert.equal(markFirstRunSeen('k', null), false);
  });

  it('survives a storage whose setItem throws (quota)', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
    };
    assert.equal(markFirstRunSeen('k', throwing), false);
    assert.equal(isFirstRun('k', throwing), true);
  });
});

describe('mobile-phi-firstrun-calm: chipLabel', () => {
  it('maps clean statuses to a short "PHI clear" label', () => {
    assert.equal(chipLabel('pass'), 'PHI clear');
    assert.equal(chipLabel('clear'), 'PHI clear');
  });

  it('maps risk statuses to "PHI risk"', () => {
    assert.equal(chipLabel('fail'), 'PHI risk');
    assert.equal(chipLabel('risk'), 'PHI risk');
  });

  it('maps review/warn to "PHI review"', () => {
    assert.equal(chipLabel('review'), 'PHI review');
    assert.equal(chipLabel('warn'), 'PHI review');
  });

  it('falls back to "On device" for idle/null/unknown', () => {
    assert.equal(chipLabel('idle'), 'On device');
    assert.equal(chipLabel(null), 'On device');
    assert.equal(chipLabel(undefined), 'On device');
    assert.equal(chipLabel('whatever'), 'On device');
    assert.equal(chipLabel('on-device'), 'On device');
  });

  it('renders a count as "PHI · n" when positive', () => {
    assert.equal(chipLabel(3), 'PHI · 3');
    assert.equal(chipLabel({ count: 7 }), 'PHI · 7');
    assert.equal(chipLabel({ status: 'fail', count: 2 }), 'PHI · 2');
  });

  it('floors fractional counts and ignores zero/negative counts', () => {
    assert.equal(chipLabel(2.9), 'PHI · 2');
    assert.equal(chipLabel(0), 'On device');
    assert.equal(chipLabel(-4), 'On device');
    assert.equal(chipLabel({ status: 'pass', count: 0 }), 'PHI clear');
  });

  it('never returns an empty string for any input', () => {
    const inputs = ['', 'pass', 'fail', 'review', null, undefined, 0, NaN, {}, { count: 1 }];
    for (const i of inputs) {
      const label = chipLabel(i);
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 0, 'empty label for ' + JSON.stringify(i));
    }
  });

  it('produces labels short enough for a ~375px chip', () => {
    for (const st of ['pass', 'fail', 'review', 'idle']) {
      assert.ok(chipLabel(st).length <= 12);
    }
  });
});

describe('mobile-phi-firstrun-calm: shouldShowCalmStrip', () => {
  it('shows only when flag on AND no dataset AND first run', () => {
    assert.equal(shouldShowCalmStrip({ hasDataset: false, firstRun: true, flagOn: true }), true);
  });

  it('hides when a dataset is loaded', () => {
    assert.equal(shouldShowCalmStrip({ hasDataset: true, firstRun: true, flagOn: true }), false);
  });

  it('hides when not a first run', () => {
    assert.equal(shouldShowCalmStrip({ hasDataset: false, firstRun: false, flagOn: true }), false);
  });

  it('hides when the flag is off', () => {
    assert.equal(shouldShowCalmStrip({ hasDataset: false, firstRun: true, flagOn: false }), false);
  });

  it('returns false (never throws) for missing/empty state', () => {
    assert.equal(shouldShowCalmStrip(), false);
    assert.equal(shouldShowCalmStrip({}), false);
    assert.equal(shouldShowCalmStrip(null), false);
  });

  it('coerces truthy/falsy inputs to a real boolean', () => {
    assert.strictEqual(shouldShowCalmStrip({ hasDataset: 0, firstRun: 1, flagOn: 1 }), true);
    assert.strictEqual(shouldShowCalmStrip({ hasDataset: '', firstRun: 'x', flagOn: 'y' }), true);
  });
});

describe('mobile-phi-firstrun-calm: calmCopy', () => {
  it('returns the four required string fields', () => {
    const c = calmCopy();
    assert.equal(typeof c.title, 'string');
    assert.equal(typeof c.body, 'string');
    assert.equal(typeof c.primary, 'string');
    assert.equal(typeof c.dismiss, 'string');
  });

  it('carries the exact on-device promise from the brief', () => {
    assert.equal(calmCopy().body, 'Files stay on this device. PHI Shield watches locally.');
  });

  it('drives file load via the primary CTA', () => {
    assert.match(calmCopy().primary, /drop a file or browse/i);
  });

  it('contains no em dash in any user-visible string', () => {
    const c = calmCopy();
    for (const v of [c.title, c.body, c.primary, c.dismiss]) {
      assert.ok(!v.includes(EM_DASH), 'em dash found in: ' + v);
    }
  });
});
