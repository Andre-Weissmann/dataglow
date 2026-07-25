// ============================================================
// DATAGLOW - Notebook to App (pure engine)
// ============================================================
// Turns a Python or R notebook that already ran on this device into ONE
// self-contained HTML file: the cells, the captured text output and the plots
// the run produced, wrapped in a calm read-only surface that opens by double
// click with no server, no install and no network.
//
// Pure by design. No DOM, no Blob, no download, no Pyodide, no WebR. The canvas
// wire owns the confirm step and the file handoff; everything here is a string
// in, string out so the exported surface can be tested without a browser.
//
// Three properties this file is responsible for:
//   1. ESCAPED. Notebook source, output and titles are attacker-shaped text as
//      far as this module is concerned. Everything is HTML-escaped before it
//      reaches the template, and the app's own inline script is a constant that
//      only ever toggles classes and reads textContent.
//   2. OFFLINE. buildAppHtml() refuses to return a file that references anything
//      off the device. assertOfflineSafe() is the check, and it runs on the
//      built output rather than on the inputs, so a future template edit that
//      pulls in a font or an analytics tag fails the build instead of shipping.
//   3. HONEST. The exported file says what it is: a snapshot of a run, not a
//      live notebook, with the date the outputs were captured.
//
// Data model in: the notebook shape of js/intelligence/python-notebook-lite.js
// and js/intelligence/r-notebook-lite.js, which agree on what matters here.
//   Notebook: { id, version, title?, cells: Cell[] }
//   Cell:     { id, type:'code'|'markdown', source, output?, images? }
//   output:   { stdout?, error?, images?, elapsedMs?, status? }

export const NOTEBOOK_APP_VERSION = 1;

export const NOTEBOOK_APP_KIND = 'dataglow.notebook-app';

export const NOTEBOOK_APP_RUNTIMES = ['python', 'r'];

// Plots arrive as data URLs from the runtime. Anything else is dropped rather
// than repaired, since an <img src> is the one place in the template where a
// remote reference could still sneak past the escaper.
const IMAGE_PREFIX = 'data:image/';

export function normalizeRuntime(runtime) {
  var key = String(runtime == null ? '' : runtime).toLowerCase();
  if (key === 'r') return 'r';
  if (key === 'python' || key === 'py') return 'python';
  return '';
}

export function runtimeLabel(runtime) {
  return normalizeRuntime(runtime) === 'r' ? 'R' : 'Python';
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(s) {
  var base = String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'notebook';
}

export function buildAppFilename(title, runtime) {
  var rt = normalizeRuntime(runtime);
  return slugify(title) + '-' + (rt || 'notebook') + '-app.html';
}

// ---- reading the notebook --------------------------------------------------

function cellsOf(nb) {
  return nb && Array.isArray(nb.cells) ? nb.cells : [];
}

function stdoutOf(cell) {
  var out = cell && cell.output;
  if (!out || typeof out !== 'object') return '';
  return typeof out.stdout === 'string' ? out.stdout : '';
}

function errorOf(cell) {
  var out = cell && cell.output;
  if (!out || typeof out !== 'object') return '';
  return typeof out.error === 'string' ? out.error : '';
}

// Images can sit on the cell (R notebooks mirror them there) or on the output.
export function imagesOf(cell) {
  var found = [];
  var push = function (list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (s) {
      if (typeof s === 'string' && s.indexOf(IMAGE_PREFIX) === 0 && found.indexOf(s) === -1) found.push(s);
    });
  };
  push(cell && cell.images);
  push(cell && cell.output && cell.output.images);
  return found;
}

export function summarizeNotebook(nb, runtime) {
  var cells = cellsOf(nb);
  var sum = {
    runtime: normalizeRuntime(runtime) || 'python',
    title: (nb && typeof nb.title === 'string' && nb.title.trim()) || 'Notebook',
    cells: cells.length,
    codeCells: 0,
    textCells: 0,
    outputCells: 0,
    errorCells: 0,
    images: 0,
    sourceChars: 0,
    outputChars: 0
  };
  cells.forEach(function (c) {
    var isCode = !c || c.type !== 'markdown';
    if (isCode) sum.codeCells += 1; else sum.textCells += 1;
    sum.sourceChars += (c && typeof c.source === 'string') ? c.source.length : 0;
    var stdout = stdoutOf(c);
    var err = errorOf(c);
    var imgs = imagesOf(c);
    if (stdout || err || imgs.length) sum.outputCells += 1;
    if (err) sum.errorCells += 1;
    sum.images += imgs.length;
    sum.outputChars += stdout.length + err.length;
  });
  return sum;
}

// Every character that would travel inside the file, so the caller can hand it
// to PHI Shield before the user is asked to confirm.
export function collectText(nb, opts) {
  opts = opts || {};
  var withOutputs = opts.includeOutputs !== false;
  var parts = [];
  if (nb && typeof nb.title === 'string') parts.push(nb.title);
  cellsOf(nb).forEach(function (c) {
    if (c && typeof c.source === 'string') parts.push(c.source);
    if (!withOutputs) return;
    var stdout = stdoutOf(c);
    var err = errorOf(c);
    if (stdout) parts.push(stdout);
    if (err) parts.push(err);
  });
  return parts.join('\n');
}

// ---- the confirm sheet ----------------------------------------------------

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

// Plain language, one fact per line, so the human confirm is a real disclosure
// of what is about to be written rather than a yes/no with no content. Wording
// deliberately avoids promising more than the file does.
export function describeDisclosure(summary, opts) {
  opts = opts || {};
  var withOutputs = opts.includeOutputs !== false;
  var s = summary || summarizeNotebook(null, 'python');
  var lines = [];

  lines.push(plural(s.codeCells, 'code cell', 'code cells') + ' and ' +
    plural(s.textCells, 'text cell', 'text cells') + ', exactly as written.');

  if (!withOutputs) {
    lines.push('No results. Code and text only, so nothing a run produced travels with the file.');
  } else if (s.outputCells === 0) {
    lines.push('No results yet. Nothing has been run, so there is nothing to capture.');
  } else {
    var res = 'Captured results from ' + plural(s.outputCells, 'cell', 'cells');
    if (s.images > 0) res += ', including ' + plural(s.images, 'plot image', 'plot images');
    lines.push(res + '.');
    if (s.errorCells > 0) {
      lines.push(plural(s.errorCells, 'cell', 'cells') + ' ended in an error, and that error text is included.');
    }
  }

  lines.push('No dataset rows and no source files. Only what appears in the cells above.');
  lines.push('The file makes no network calls and holds no keys, cookies or tracking.');
  lines.push('It is saved to the folder you pick. Sharing it afterwards is your choice.');
  return lines;
}

// ---- offline proof --------------------------------------------------------

function blocksOf(html, tag) {
  var re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// Run against the BUILT html, so a template that grows a font, a CDN script or
// a tracking pixel fails here instead of shipping.
//
// Scope matters. A URL sitting in notebook text is inert: it was escaped, it
// lives in a <pre>, and nothing fetches it. Flagging those would refuse to
// export any notebook whose code mentions an API, which is most of them. So
// only the three places that can actually reach the network are scanned:
// fetchable attributes, the style block, and the script block.
export function findExternalReferences(html) {
  var text = String(html == null ? '' : html);
  var findings = [];
  var add = function (kind, value) {
    findings.push({ kind: kind, value: String(value).slice(0, 120) });
  };
  var m;

  var reAttr = /\b(?:src|href|poster|action|formaction|srcset|data|background)\s*=\s*["']([^"']*)["']/gi;
  while ((m = reAttr.exec(text)) !== null) {
    var val = m[1].trim();
    if (val.indexOf(IMAGE_PREFIX) === 0) continue;
    if (val.charAt(0) === '#') continue;
    add('fetchable-attribute', m[0]);
  }

  blocksOf(text, 'style').forEach(function (css) {
    var reImport = /@import\b/gi;
    while ((m = reImport.exec(css)) !== null) add('css-import', m[0]);
    var reCssUrl = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
    while ((m = reCssUrl.exec(css)) !== null) {
      if (m[2].trim().indexOf(IMAGE_PREFIX) === 0) continue;
      add('css-url', m[0]);
    }
  });

  blocksOf(text, 'script').forEach(function (js) {
    var reApi = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon|import\s*\()/g;
    while ((m = reApi.exec(js)) !== null) add('network-api', m[0]);
    var reUrl = /\b(?:https?:|ftp:|wss?:)\/\/[^\s"'<>)]+/gi;
    while ((m = reUrl.exec(js)) !== null) add('script-url', m[0]);
  });

  return findings;
}

export function assertOfflineSafe(html) {
  var findings = findExternalReferences(html);
  return { ok: findings.length === 0, findings: findings };
}

// ---- tiny markdown (escape first, then a few marks) -----------------------

function renderMarkdown(source) {
  var lines = String(source == null ? '' : source).replace(/\r\n/g, '\n').split('\n');
  var out = [];
  lines.forEach(function (raw) {
    var head = /^(#{1,3})\s+(.*)$/.exec(raw);
    var body = head ? head[2] : raw;
    var esc = escapeHtml(body)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (head) out.push('<h' + head[1].length + '>' + esc + '</h' + head[1].length + '>');
    else if (body.trim() === '') out.push('');
    else out.push('<p>' + esc + '</p>');
  });
  return out.filter(function (s) { return s !== ''; }).join('\n');
}

// ---- the exported surface -------------------------------------------------

const APP_CSS = [
  ':root{color-scheme:light dark;--bg:#0F1115;--surface:#151820;--surface2:#1B1F29;',
  '--border:#282D38;--text:#E9EBEF;--muted:#9AA1AE;--accent:#20C5B5;--warn:#E3A34A;--err:#E85D4C}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--text);',
  'font:15px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
  '.wrap{max-width:920px;margin:0 auto;padding:24px 18px 64px}',
  'header.top{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:18px}',
  'h1.title{margin:0 0 6px;font-size:26px;line-height:1.25;font-weight:800}',
  '.badges{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}',
  '.badge{font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;',
  'border:1px solid var(--border);border-radius:999px;padding:5px 11px;color:var(--muted)}',
  '.badge.rt{border-color:var(--accent);color:var(--accent)}',
  '.note{font-size:12.5px;color:var(--muted);margin:12px 0 0;line-height:1.55}',
  '.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:18px 0 20px}',
  '.bar input{flex:1 1 220px;min-height:44px;padding:0 12px;border-radius:10px;',
  'border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:14px}',
  '.bar button{min-height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--border);',
  'background:var(--surface2);color:var(--text);font:inherit;font-size:13px;font-weight:700;cursor:pointer}',
  '.bar button:hover{border-color:var(--accent);color:var(--accent)}',
  '.cell{border:1px solid var(--border);border-radius:12px;background:var(--surface);',
  'margin:0 0 14px;overflow:hidden}',
  '.cell.hidden{display:none}',
  '.cell .head{display:flex;gap:8px;align-items:center;padding:7px 12px;font-size:11px;',
  'color:var(--muted);border-bottom:1px solid var(--border);letter-spacing:.04em;text-transform:uppercase}',
  '.cell .head .n{margin-left:auto;text-transform:none;letter-spacing:0}',
  'pre{margin:0;padding:12px 14px;overflow-x:auto;',
  'font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}',
  'pre.src{color:var(--text);background:transparent}',
  'pre.out{color:#B7BDC8;border-top:1px solid var(--border);background:rgba(0,0,0,.18)}',
  'pre.out.err{color:var(--err)}',
  'body.nocode pre.src{display:none}',
  '.md{padding:4px 14px 12px}',
  '.md h1,.md h2,.md h3{margin:14px 0 6px;line-height:1.3}',
  '.md h1{font-size:21px}.md h2{font-size:18px}.md h3{font-size:16px}',
  '.md p{margin:8px 0}',
  '.md code,pre code{background:var(--surface2);border-radius:5px;padding:1px 5px;',
  'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  'img.plot{display:block;max-width:100%;height:auto;border-top:1px solid var(--border);background:#fff}',
  '.empty{color:var(--muted);font-size:13px;padding:14px}',
  'footer.foot{margin-top:26px;padding-top:16px;border-top:1px solid var(--border);',
  'font-size:12px;line-height:1.6;color:var(--muted)}',
  '@media print{.bar{display:none}body{background:#fff;color:#111}',
  '.cell{break-inside:avoid;border-color:#ccc}pre.out{background:#f6f6f6;color:#222}}'
].join('');

// Constant. It only toggles classes and reads textContent, so no notebook text
// is ever interpreted as code or markup by the exported file.
const APP_JS = [
  "(function(){'use strict';",
  "var q=document.getElementById('dg-q');",
  "var cells=[].slice.call(document.querySelectorAll('.cell'));",
  "function filter(){",
  "var t=(q.value||'').toLowerCase();",
  "var shown=0;",
  "cells.forEach(function(c){",
  "var hit=!t||(c.textContent||'').toLowerCase().indexOf(t)!==-1;",
  "if(hit)shown++;",
  "c.classList.toggle('hidden',!hit);});",
  "var e=document.getElementById('dg-empty');",
  "if(e)e.style.display=shown?'none':'block';}",
  "if(q)q.addEventListener('input',filter);",
  "var t=document.getElementById('dg-toggle-code');",
  "if(t)t.addEventListener('click',function(){",
  "var off=document.body.classList.toggle('nocode');",
  "t.textContent=off?'Show code':'Hide code';});",
  "var p=document.getElementById('dg-print');",
  "if(p)p.addEventListener('click',function(){window.print();});",
  '})();'
].join('');

function renderCell(cell, index, withOutputs) {
  var isCode = !cell || cell.type !== 'markdown';
  var parts = [];
  parts.push('<section class="cell">');
  parts.push('<div class="head"><span>' + (isCode ? 'Code' : 'Text') + '</span>' +
    '<span class="n">' + (index + 1) + '</span></div>');

  var source = (cell && typeof cell.source === 'string') ? cell.source : '';
  if (isCode) {
    parts.push('<pre class="src"><code>' + escapeHtml(source) + '</code></pre>');
  } else {
    parts.push('<div class="md">' + renderMarkdown(source) + '</div>');
  }

  if (withOutputs && isCode) {
    var stdout = stdoutOf(cell);
    var err = errorOf(cell);
    if (stdout) parts.push('<pre class="out">' + escapeHtml(stdout) + '</pre>');
    if (err) parts.push('<pre class="out err">' + escapeHtml(err) + '</pre>');
    imagesOf(cell).forEach(function (src) {
      parts.push('<img class="plot" alt="Plot from cell ' + (index + 1) + '" src="' + escapeHtml(src) + '">');
    });
  }
  parts.push('</section>');
  return parts.join('');
}

function capturedOnLine(summary, withOutputs, generatedAt) {
  var when = escapeHtml(generatedAt);
  if (!withOutputs || summary.outputCells === 0) {
    return 'Saved on ' + when + '. Code and text only, with no captured results.';
  }
  return 'Results captured on ' + when + '. This is a snapshot of that run, not a live notebook.';
}

/**
 * Build the one-file app. Returns { ok, html, filename, summary } or, when the
 * built file would reference anything off the device, { ok:false, error, findings }.
 */
export function buildAppHtml(nb, opts) {
  opts = opts || {};
  var runtime = normalizeRuntime(opts.runtime) || 'python';
  var withOutputs = opts.includeOutputs !== false;
  var summary = summarizeNotebook(nb, runtime);
  var title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : summary.title;
  summary.title = title;
  var generatedAt = typeof opts.generatedAt === 'string' && opts.generatedAt
    ? opts.generatedAt
    : new Date().toISOString().slice(0, 10);

  var cells = cellsOf(nb);
  var body = cells.map(function (c, i) { return renderCell(c, i, withOutputs); }).join('\n');
  if (!cells.length) {
    body = '<div class="cell"><div class="empty">This notebook has no cells.</div></div>';
  }

  var html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="generator" content="' + NOTEBOOK_APP_KIND + ' v' + NOTEBOOK_APP_VERSION + '">',
    '<title>' + escapeHtml(title) + '</title>',
    '<style>' + APP_CSS + '<\/style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<header class="top">',
    '<h1 class="title">' + escapeHtml(title) + '</h1>',
    '<div class="badges">',
    '<span class="badge rt">' + escapeHtml(runtimeLabel(runtime)) + ' notebook</span>',
    '<span class="badge">' + plural(summary.codeCells, 'code cell', 'code cells') + '</span>',
    '<span class="badge">' + plural(summary.textCells, 'text cell', 'text cells') + '</span>',
    withOutputs && summary.images > 0
      ? '<span class="badge">' + plural(summary.images, 'plot', 'plots') + '</span>'
      : '',
    '</div>',
    '<p class="note">' + capturedOnLine(summary, withOutputs, generatedAt) + '</p>',
    '<p class="note">Made on the device that ran it, with DataGlow. This file is self contained: ' +
      'it opens by double click, works with no internet, and sends nothing anywhere.</p>',
    '</header>',
    '<div class="bar">',
    '<input id="dg-q" type="search" placeholder="Filter cells" aria-label="Filter cells">',
    '<button type="button" id="dg-toggle-code">Hide code</button>',
    '<button type="button" id="dg-print">Print</button>',
    '</div>',
    '<main id="dg-cells">',
    body,
    '</main>',
    '<div class="empty" id="dg-empty" style="display:none">No cell matches that filter.</div>',
    '<footer class="foot">',
    '<p>Read only. Editing a cell here does not re-run anything, because there is no ' +
      escapeHtml(runtimeLabel(runtime)) + ' engine in this file. Open the notebook in DataGlow to run it again.</p>',
    '<p>Outputs are whatever the cells printed on this device at the time above. ' +
      'They are not re-checked here, so treat them the way you would treat any saved report.</p>',
    '</footer>',
    '</div>',
    '<script>' + APP_JS + '<\/script>',
    '</body>',
    '</html>',
    ''
  ].filter(function (s) { return s !== ''; }).join('\n');

  var safe = assertOfflineSafe(html);
  if (!safe.ok) {
    return {
      ok: false,
      error: 'The app file would reference something off this device, so it was not created.',
      findings: safe.findings
    };
  }

  return {
    ok: true,
    html: html,
    filename: buildAppFilename(title, runtime),
    bytes: html.length,
    summary: summary
  };
}

export const DataGlowNotebookAppExport = {
  version: NOTEBOOK_APP_VERSION,
  kind: NOTEBOOK_APP_KIND,
  runtimes: NOTEBOOK_APP_RUNTIMES,
  normalizeRuntime: normalizeRuntime,
  runtimeLabel: runtimeLabel,
  escapeHtml: escapeHtml,
  slugify: slugify,
  buildAppFilename: buildAppFilename,
  imagesOf: imagesOf,
  summarizeNotebook: summarizeNotebook,
  collectText: collectText,
  describeDisclosure: describeDisclosure,
  findExternalReferences: findExternalReferences,
  assertOfflineSafe: assertOfflineSafe,
  buildAppHtml: buildAppHtml
};

if (typeof window !== 'undefined') {
  window.DataGlowNotebookAppExport = DataGlowNotebookAppExport;
}
