/**
 * Notebook to App (pure engine) tests.
 *
 * No DOM, no Blob, no download. What is pinned here is the contract the canvas
 * wire and the confirm sheet lean on:
 *   - the disclosure lines say what actually goes in the file, and change when
 *     the "leave the results out" choice changes;
 *   - notebook text is escaped, so a cell cannot inject markup or script into
 *     the exported surface;
 *   - the built file references nothing off the device, and a template that
 *     grew a font or a tracking pixel would fail the build rather than ship;
 *   - a notebook whose code merely mentions a URL or the word fetch still
 *     exports, because escaped text in a <pre> reaches no network;
 *   - no user-visible string carries an em dash.
 *
 * RUN WITH:  node --test test/notebook-app-export.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTEBOOK_APP_VERSION,
  NOTEBOOK_APP_KIND,
  NOTEBOOK_APP_RUNTIMES,
  normalizeRuntime,
  runtimeLabel,
  escapeHtml,
  slugify,
  buildAppFilename,
  imagesOf,
  summarizeNotebook,
  collectText,
  describeDisclosure,
  findExternalReferences,
  assertOfflineSafe,
  buildAppHtml,
  DataGlowNotebookAppExport,
} from '../js/intelligence/notebook-app-export.js';

const EM_DASH = '—';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SVG = 'data:image/svg+xml;base64,PHN2Zy8+';

function notebook(extra) {
  return Object.assign({
    id: 'nb-1',
    version: 1,
    title: 'Claims quality',
    cells: [
      { id: 'c1', type: 'markdown', source: '# Claims quality\n\nA **short** look at `denials`.' },
      {
        id: 'c2',
        type: 'code',
        source: 'print(df.shape)',
        output: { stdout: '(1200, 14)\n', images: [], status: 'ok', elapsedMs: 12 },
      },
      {
        id: 'c3',
        type: 'code',
        source: 'plot(denials)',
        output: { stdout: '', images: [PNG], status: 'ok' },
      },
    ],
  }, extra || {});
}

function withError() {
  const nb = notebook();
  nb.cells.push({
    id: 'c4',
    type: 'code',
    source: 'df["missing"]',
    output: { stdout: '', error: 'KeyError: missing', status: 'error' },
  });
  return nb;
}

describe('notebook app: module shape', () => {
  it('exports a version, a kind and the full public API on the namespace object', () => {
    assert.equal(NOTEBOOK_APP_VERSION, 1);
    assert.equal(NOTEBOOK_APP_KIND, 'dataglow.notebook-app');
    assert.deepEqual(NOTEBOOK_APP_RUNTIMES, ['python', 'r']);
    for (const fn of [
      'normalizeRuntime', 'runtimeLabel', 'escapeHtml', 'slugify', 'buildAppFilename',
      'imagesOf', 'summarizeNotebook', 'collectText', 'describeDisclosure',
      'findExternalReferences', 'assertOfflineSafe', 'buildAppHtml',
    ]) {
      assert.equal(typeof DataGlowNotebookAppExport[fn], 'function', `missing ${fn}`);
    }
  });

  it('covers both notebook runtimes and nothing else', () => {
    assert.equal(normalizeRuntime('python'), 'python');
    assert.equal(normalizeRuntime('py'), 'python');
    assert.equal(normalizeRuntime('R'), 'r');
    assert.equal(normalizeRuntime('julia'), '');
    assert.equal(normalizeRuntime(undefined), '');
    assert.equal(runtimeLabel('r'), 'R');
    assert.equal(runtimeLabel('python'), 'Python');
  });
});

describe('notebook app: filenames', () => {
  it('builds a calm, predictable filename from the title', () => {
    assert.equal(buildAppFilename('Claims quality', 'python'), 'claims-quality-python-app.html');
    assert.equal(buildAppFilename('Q1 / Q2  denials!', 'r'), 'q1-q2-denials-r-app.html');
  });

  it('never produces a path, an extension trick or an empty name', () => {
    assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
    assert.equal(slugify(''), 'notebook');
    assert.equal(slugify('   '), 'notebook');
    assert.equal(buildAppFilename('', ''), 'notebook-notebook-app.html');
    for (const title of ['../../etc/passwd', 'a\\b', 'x".html', '.....']) {
      const name = buildAppFilename(title, 'python');
      assert.ok(!/[\\/]/.test(name), `no separators in ${name}`);
      assert.ok(/^[a-z0-9-]+-(python|r|notebook)-app\.html$/.test(name), `unexpected name ${name}`);
    }
  });
});

describe('notebook app: reading the notebook', () => {
  it('summarizes cells, outputs, errors and plots', () => {
    const s = summarizeNotebook(withError(), 'r');
    assert.equal(s.runtime, 'r');
    assert.equal(s.title, 'Claims quality');
    assert.equal(s.cells, 4);
    assert.equal(s.codeCells, 3);
    assert.equal(s.textCells, 1);
    assert.equal(s.outputCells, 3);
    assert.equal(s.errorCells, 1);
    assert.equal(s.images, 1);
    assert.ok(s.sourceChars > 0);
    assert.ok(s.outputChars > 0);
  });

  it('is safe on an empty or absent notebook', () => {
    for (const nb of [null, undefined, {}, { cells: 'nope' }]) {
      const s = summarizeNotebook(nb, 'python');
      assert.equal(s.cells, 0);
      assert.equal(s.images, 0);
      assert.equal(s.title, 'Notebook');
    }
  });

  it('takes plots from the cell or the output, dedupes them, and drops anything not a data image', () => {
    assert.deepEqual(imagesOf({ images: [PNG], output: { images: [PNG, SVG] } }), [PNG, SVG]);
    assert.deepEqual(imagesOf({ output: { images: ['https://cdn.example/p.png', '', null, 7] } }), []);
    assert.deepEqual(imagesOf(null), []);
  });

  it('collects every character that would travel, so PHI Shield sees the real payload', () => {
    const all = collectText(notebook(), { includeOutputs: true });
    assert.ok(all.includes('print(df.shape)'));
    assert.ok(all.includes('(1200, 14)'));
    assert.ok(all.includes('Claims quality'));

    const codeOnly = collectText(notebook(), { includeOutputs: false });
    assert.ok(codeOnly.includes('print(df.shape)'));
    assert.ok(!codeOnly.includes('(1200, 14)'), 'results must be left out when they are excluded');
  });
});

describe('notebook app: the disclosure the human confirms', () => {
  it('counts what goes in and names the plots', () => {
    const lines = describeDisclosure(summarizeNotebook(notebook(), 'python'), { includeOutputs: true });
    assert.ok(lines.length >= 4);
    assert.match(lines[0], /2 code cells and 1 text cell, exactly as written\./);
    assert.match(lines[1], /Captured results from 2 cells, including 1 plot image\./);
    assert.ok(lines.some((l) => /No dataset rows and no source files/.test(l)));
    assert.ok(lines.some((l) => /makes no network calls and holds no keys, cookies or tracking/.test(l)));
    assert.ok(lines.some((l) => /Sharing it afterwards is your choice/.test(l)));
  });

  it('says errors travel too, since that is the surprising part', () => {
    const lines = describeDisclosure(summarizeNotebook(withError(), 'python'), { includeOutputs: true });
    assert.ok(lines.some((l) => /1 cell ended in an error, and that error text is included\./.test(l)));
  });

  it('changes when the human leaves the results out', () => {
    const lines = describeDisclosure(summarizeNotebook(notebook(), 'python'), { includeOutputs: false });
    assert.ok(lines.some((l) => /No results\. Code and text only/.test(l)));
    assert.ok(!lines.some((l) => /Captured results/.test(l)));
    assert.ok(!lines.some((l) => /plot image/.test(l)));
  });

  it('does not claim results exist before anything has run', () => {
    const nb = { cells: [{ id: 'c1', type: 'code', source: 'print(1)' }] };
    const lines = describeDisclosure(summarizeNotebook(nb, 'python'), { includeOutputs: true });
    assert.ok(lines.some((l) => /Nothing has been run, so there is nothing to capture\./.test(l)));
  });

  it('is safe with no summary at all', () => {
    assert.ok(describeDisclosure().length >= 4);
    assert.ok(describeDisclosure(null, {}).length >= 4);
  });

  it('never uses an em dash', () => {
    for (const opts of [{ includeOutputs: true }, { includeOutputs: false }]) {
      for (const nb of [notebook(), withError(), {}]) {
        describeDisclosure(summarizeNotebook(nb, 'python'), opts).forEach((l) => {
          assert.ok(!l.includes(EM_DASH), `em dash in: ${l}`);
        });
      }
    }
  });
});

describe('notebook app: escaping', () => {
  it('escapes the five characters that could break out of the template', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'),
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('cannot be talked into emitting a script tag from a cell', () => {
    const nb = {
      title: '</title><script>alert(1)</script>',
      cells: [
        { id: 'c1', type: 'code', source: '</script><img src=x onerror=alert(1)>' },
        { id: 'c2', type: 'markdown', source: '<script>alert(2)</script>\n**bold**' },
        { id: 'c3', type: 'code', source: 'ok', output: { stdout: '</pre><script>alert(3)</script>' } },
      ],
    };
    const built = buildAppHtml(nb, { runtime: 'python', generatedAt: '2026-07-25' });
    assert.equal(built.ok, true);
    // Exactly one script tag pair: the app's own constant script. The alert()
    // text itself survives as escaped text, which is the point: it is shown,
    // not run.
    assert.equal((built.html.match(/<script/gi) || []).length, 1);
    assert.ok(!/<script[^>]*>\s*alert/i.test(built.html), 'no executable alert');
    // The onerror text survives escaped, inside &lt;img ...&gt;; what must not
    // exist is a real tag carrying it.
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(built.html), 'no event handler on any real tag');
    assert.ok(!/<img/i.test(built.html), 'this notebook has no plots, so no img tag at all');
    assert.ok(built.html.includes('onerror=alert(1)&gt;'), 'it is shown as text');
    assert.ok(built.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(built.html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(built.html.includes('&lt;/pre&gt;&lt;script&gt;alert(3)&lt;/script&gt;'));
  });

  it('keeps the few markdown marks it supports without letting markup through', () => {
    const built = buildAppHtml(
      { cells: [{ id: 'c1', type: 'markdown', source: '## Head\n\n**b** and `c` and <b>raw</b>' }] },
      { runtime: 'python', title: 'Notes', generatedAt: '2026-07-25' },
    );
    assert.ok(built.html.includes('<h2>Head</h2>'));
    assert.ok(built.html.includes('<strong>b</strong>'));
    assert.ok(built.html.includes('<code>c</code>'));
    assert.ok(built.html.includes('&lt;b&gt;raw&lt;/b&gt;'), 'raw markup stays text');
  });

  it('drops a remote plot rather than emitting a remote img src', () => {
    const built = buildAppHtml(
      { cells: [{ id: 'c1', type: 'code', source: 'plot()', output: { images: ['https://cdn.example/p.png', PNG] } }] },
      { runtime: 'r', title: 'Plots', generatedAt: '2026-07-25' },
    );
    assert.equal(built.ok, true, 'a remote plot is dropped, not a build failure');
    assert.ok(!built.html.includes('cdn.example'));
    assert.ok(built.html.includes(PNG));
  });
});

describe('notebook app: the offline proof', () => {
  it('flags the things that would actually reach the network', () => {
    const cases = [
      ['<img src="https://cdn.example/x.png">', 'fetchable-attribute'],
      ['<link href="/theme.css">', 'fetchable-attribute'],
      ['<style>@import url(https://fonts.example/f.css);</style>', 'css-import'],
      ['<style>body{background:url(bg.png)}</style>', 'css-url'],
      ['<script>fetch("/api")</script>', 'network-api'],
      ['<script>new WebSocket("wss://x.example")</script>', 'network-api'],
      ['<script>var u = "https://x.example/beacon";</script>', 'script-url'],
    ];
    for (const [html, kind] of cases) {
      const found = findExternalReferences(html);
      assert.ok(found.length > 0, `nothing flagged in ${html}`);
      assert.ok(found.some((f) => f.kind === kind), `expected ${kind} for ${html}`);
      assert.equal(assertOfflineSafe(html).ok, false);
    }
  });

  it('leaves inert things alone: data images, in-page anchors, and escaped notebook text', () => {
    const inert = [
      '<img src="' + PNG + '">',
      '<a href="#top">top</a>',
      '<style>.a{background:url(' + PNG + ')}</style>',
      '<pre>import requests  # https://api.example.com/v1 then fetch()</pre>',
      '',
    ];
    for (const html of inert) {
      assert.deepEqual(findExternalReferences(html), [], `false positive in ${html}`);
      assert.equal(assertOfflineSafe(html).ok, true);
    }
    assert.equal(assertOfflineSafe(null).ok, true);
  });

  it('still exports a notebook whose code talks about the network', () => {
    const nb = {
      cells: [
        { id: 'c1', type: 'code', source: 'import requests\nr = requests.get("https://api.example.com/v1")' },
        { id: 'c2', type: 'code', source: 'await fetch("/local")', output: { stdout: 'GET https://api.example.com/v1 200' } },
        { id: 'c3', type: 'markdown', source: 'See https://api.example.com/v1 for the schema.' },
      ],
    };
    const built = buildAppHtml(nb, { runtime: 'python', title: 'API notes', generatedAt: '2026-07-25' });
    assert.equal(built.ok, true, built.ok ? '' : JSON.stringify(built.findings));
    assert.ok(built.html.includes('api.example.com'), 'the text is kept, it is just inert');
  });

  it('refuses a built file that would reference something off the device', () => {
    // Proves the gate has teeth: the same assertion buildAppHtml runs, applied
    // to a template that grew a remote font.
    const poisoned = '<!doctype html><html><head><link href="https://fonts.example/f.css"></head><body></body></html>';
    const check = assertOfflineSafe(poisoned);
    assert.equal(check.ok, false);
    assert.equal(check.findings[0].kind, 'fetchable-attribute');
  });
});

describe('notebook app: the built file', () => {
  const built = buildAppHtml(withError(), {
    runtime: 'r',
    title: 'Claims quality',
    includeOutputs: true,
    generatedAt: '2026-07-25',
  });

  it('is one self-contained document with a real filename and byte count', () => {
    assert.equal(built.ok, true);
    assert.equal(built.filename, 'claims-quality-r-app.html');
    assert.equal(built.bytes, built.html.length);
    assert.ok(built.html.startsWith('<!doctype html>'));
    assert.ok(built.html.trimEnd().endsWith('</html>'));
    assert.ok(built.html.includes('<meta name="generator" content="dataglow.notebook-app v1">'));
    assert.equal((built.html.match(/<style/gi) || []).length, 1);
    assert.equal((built.html.match(/<script/gi) || []).length, 1);
  });

  it('carries the cells, the captured output, the error text and the plot', () => {
    assert.ok(built.html.includes('print(df.shape)'));
    assert.ok(built.html.includes('(1200, 14)'));
    assert.ok(built.html.includes('KeyError: missing'));
    assert.ok(built.html.includes(PNG));
    assert.ok(built.html.includes('R notebook'), 'says which runtime produced it');
  });

  it('says it is a snapshot of a run rather than a live notebook', () => {
    assert.ok(built.html.includes('Results captured on 2026-07-25'));
    assert.ok(built.html.includes('snapshot of that run, not a live notebook'));
    assert.ok(built.html.includes('there is no R engine in this file'));
  });

  it('leaves every result out when the human says so', () => {
    const codeOnly = buildAppHtml(withError(), {
      runtime: 'python',
      title: 'Claims quality',
      includeOutputs: false,
      generatedAt: '2026-07-25',
    });
    assert.equal(codeOnly.ok, true);
    assert.ok(codeOnly.html.includes('print(df.shape)'), 'the code is still there');
    assert.ok(!codeOnly.html.includes('(1200, 14)'), 'no captured stdout');
    assert.ok(!codeOnly.html.includes('KeyError'), 'no captured error');
    assert.ok(!codeOnly.html.includes(PNG), 'no captured plot');
    assert.ok(codeOnly.html.includes('Code and text only, with no captured results'));
  });

  it('handles a notebook with no cells without pretending otherwise', () => {
    const empty = buildAppHtml({ cells: [] }, { runtime: 'python', generatedAt: '2026-07-25' });
    assert.equal(empty.ok, true);
    assert.ok(empty.html.includes('This notebook has no cells.'));
    assert.equal(empty.filename, 'notebook-python-app.html');
  });

  it('is safe with no notebook and no options at all', () => {
    const bare = buildAppHtml();
    assert.equal(bare.ok, true);
    assert.ok(bare.html.includes('<!doctype html>'));
  });

  it('never uses an em dash in the file it writes', () => {
    assert.ok(!built.html.includes(EM_DASH));
  });
});
