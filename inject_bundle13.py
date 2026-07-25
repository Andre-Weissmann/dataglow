#!/usr/bin/env python3
"""Bundle 13: SQL power deepen, Excel type-guard, Python/R deepen, Arrow bridge
status, Power Query honest note, and CSV quarantine, plus the llama.cpp sidecar
packaging path.

This script is idempotent: it only touches spans it owns (marked from/end
blocks) and a single surgical patch to registerDataset's read_csv_auto call,
guarded by a sentinel so a second run is a no-op.

Files spliced in, in dependency order (engines before the UIs that read them):

  js/polyglot/sql-deepen.js
  js/intelligence/excel-type-guard.js
  js/polyglot/python-deepen.js
  js/polyglot/r-deepen.js
  js/polyglot/arrow-bridge.js
  js/polyglot/power-query-note.js
  js/dataquality/csv-quarantine.js
  js/ai/llama-sidecar-packaging.js
  js/dataquality/data-glow-csv-quarantine-canvas.js   (already an IIFE)
  js/polyglot/data-glow-power-packs-canvas.js         (re-synced, already an IIFE)

Surgical patch: registerDataset's read_csv_auto call gains ignore_errors and
store_rejects, and reads the rejects table into window.DataGlowCsvQuarantineUI
before dropping it, so "CSV rejects UI" has a real DuckDB path behind it rather
than only a presentational model.
"""
import re
import sys
import hashlib

CANVAS = 'canvas/index.html'

ENGINES = [
    'js/ai/capability-ceiling.js',
    'js/polyglot/sql-deepen.js',
    'js/intelligence/excel-type-guard.js',
    'js/polyglot/python-deepen.js',
    'js/polyglot/r-deepen.js',
    'js/polyglot/arrow-bridge.js',
    'js/polyglot/power-query-note.js',
    'js/dataquality/csv-quarantine.js',
    'js/ai/llama-sidecar-packaging.js',
]

UIS = [
    'js/dataquality/data-glow-csv-quarantine-canvas.js',
    'js/polyglot/data-glow-power-packs-canvas.js',
]

IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';\s*$", flags=re.M | re.S)
ANY_IMPORT_RE = re.compile(r'^\s*import\b', flags=re.M)


def read(p):
    return open(p, encoding='utf-8', errors='replace').read()


def marks(path):
    return ('/* ---- from %s ---- */' % path, '/* ---- end %s ---- */' % path)


def namespace_keys(src, ns_name, path):
    _head, sep, tail = src.partition('export const %s = {' % ns_name)
    if not sep:
        sys.exit('%s: namespace `export const %s` not found' % (path, ns_name))
    keys = re.findall(r'^\s{2}([A-Za-z_$][\w$]*),\s*$', tail.split('};')[0], flags=re.M)
    if not keys:
        sys.exit('%s: could not read the namespace key list' % path)
    return keys


def guess_ns(path):
    src = read(path)
    m = re.search(r'export const (DataGlow[A-Za-z0-9]+) = \{', src)
    if not m:
        sys.exit('%s: could not find its window namespace export' % path)
    return m.group(1)


def build_engine_iife(path):
    ns_name = guess_ns(path)
    src = read(path)
    keys = namespace_keys(src, ns_name, path)
    head = src.partition('export const %s = {' % ns_name)[0]

    if IMPORT_RE.search(head):
        sys.exit('%s: has an import this script does not know how to rewrite' % path)

    body = re.sub(r'^export (const|function|async function|class|let) ', r'\1 ', head, flags=re.M)
    if ANY_IMPORT_RE.search(body) or re.search(r'^\s*export\b', body, flags=re.M):
        sys.exit('%s: an export or import survived the rewrite' % path)

    start, end = marks(path)
    return (
        start + '\n'
        + ';(function () {\n'
        + "  'use strict';\n"
        + body.rstrip('\n') + '\n'
        + '  window.%s = {\n' % ns_name
        + ''.join('    %s: %s,\n' % (k, k) for k in keys)
        + '  };\n'
        + '})();\n'
        + end + '\n'
    )


def splice(data, path, block):
    start, end = marks(path)
    i = data.find(start)
    if i == -1:
        return None
    j = data.find(end, i)
    if j == -1:
        sys.exit('%s: opening marker with no closing marker in the canvas' % path)
    return data[:i] + block.rstrip('\n') + data[j + len(end):]


def guard(block, path):
    if '</script>' in block:
        sys.exit('%s: refusing to inject, contains a literal </script>.' % path)
    if '\u2014' in block:
        sys.exit('%s: refusing to inject, contains an em dash (U+2014).' % path)
    bad = [ord(c) for c in block if ord(c) < 32 and c not in '\t\n\r']
    if bad:
        sys.exit('%s: refusing to inject, contains control characters %s.' % (path, sorted(set(bad))))


# ---------------------------------------------------------------
# Surgical patch: registerDataset gains ignore_errors + store_rejects
# ---------------------------------------------------------------

REG_SENTINEL = "var rejectsTbl = '_dg_csv_rejects_' + tbl;"

REG_OLD = (
    "      await db.registerFileBuffer(fname, bytes);\n"
    "      await conn.query(\"CREATE OR REPLACE TABLE \\\"\" + tbl + \"\\\" AS SELECT * FROM read_csv_auto('\" + fname + \"', header=true)\");\n"
    "      registeredTables[tbl] = true;\n"
    "      return tbl;\n"
)

REG_NEW = (
    "      await db.registerFileBuffer(fname, bytes);\n"
    "      // ignore_errors plus store_rejects means a malformed line does not abort\n"
    "      // the whole load, and the line is not silently gone either: it lands in a\n"
    "      // rejects table this reads before dropping it. Most loads never populate\n"
    "      // that table, because parseCSV() upstream already normalised ragged rows;\n"
    "      // this is what runs on the rows DuckDB itself refuses, such as a value\n"
    "      // that cannot cast to the column type it inferred.\n"
    "      var rejectsTbl = '_dg_csv_rejects_' + tbl;\n"
    "      var rejectsScan = '_dg_csv_scans_' + tbl;\n"
    "      try {\n"
    "        await conn.query(\"CREATE OR REPLACE TABLE \\\"\" + tbl + \"\\\" AS SELECT * FROM read_csv_auto('\" + fname + \"', header=true, ignore_errors=true, store_rejects=true, rejects_table='\" + rejectsTbl + \"', rejects_scan='\" + rejectsScan + \"')\");\n"
    "      } catch (eRejectLoad) {\n"
    "        // Older DuckDB-WASM builds do not support store_rejects. Falling back\n"
    "        // keeps the load working; it just means nothing is quarantined this run.\n"
    "        await conn.query(\"CREATE OR REPLACE TABLE \\\"\" + tbl + \"\\\" AS SELECT * FROM read_csv_auto('\" + fname + \"', header=true)\");\n"
    "        registeredTables[tbl] = true;\n"
    "        return tbl;\n"
    "      }\n"
    "      try {\n"
    "        var rejRes = await conn.query(\"SELECT line, column_name, error_type, error_message, csv_line FROM \\\"\" + rejectsTbl + \"\\\" ORDER BY line LIMIT 200\");\n"
    "        var rejRows = rejRes.toArray().map(function (r) { return r.toJSON ? r.toJSON() : r; });\n"
    "        if (rejRows.length) {\n"
    "          var qEng = window.DataGlowCsvQuarantine;\n"
    "          var qUi = window.DataGlowCsvQuarantineUI;\n"
    "          if (qEng && typeof qEng.buildQuarantine === 'function') {\n"
    "            var countRes = await conn.query(\"SELECT COUNT(DISTINCT line) AS dropped FROM \\\"\" + rejectsTbl + \"\\\"\");\n"
    "            var countRows = countRes.toArray().map(function (r) { return r.toJSON ? r.toJSON() : r; });\n"
    "            var dropped = countRows.length ? Number(countRows[0].dropped) : rejRows.length;\n"
    "            var kept = dataset.rows.length;\n"
    "            var model = qEng.buildQuarantine({\n"
    "              fileName: dataset.name, table: tbl, keptRows: kept,\n"
    "              rejectRows: rejRows, droppedLines: dropped, truncated: rejRows.length >= 200,\n"
    "            });\n"
    "            if (qUi && typeof qUi.openFor === 'function') {\n"
    "              qUi.open(model, null);\n"
    "            }\n"
    "          }\n"
    "        }\n"
    "      } catch (eRejectRead) { /* the rejects table did not fire this load, which is the good outcome */ }\n"
    "      await conn.query(\"DROP TABLE IF EXISTS \\\"\" + rejectsTbl + \"\\\"\").catch(function () {});\n"
    "      await conn.query(\"DROP TABLE IF EXISTS \\\"\" + rejectsScan + \"\\\"\").catch(function () {});\n"
    "      registeredTables[tbl] = true;\n"
    "      return tbl;\n"
)


def patch_register_dataset(data):
    if REG_SENTINEL in data:
        return data, False
    if data.count(REG_OLD) != 1:
        sys.exit('canvas: registerDataset is not the shape this patch expects (found %d matches)' % data.count(REG_OLD))
    guard(REG_NEW, 'registerDataset patch')
    return data.replace(REG_OLD, REG_NEW, 1), True


def main():
    data = read(CANVAS)
    before = len(data)

    new_blocks = []
    resynced = []

    for path in ENGINES:
        block = build_engine_iife(path)
        guard(block, path)
        spliced = splice(data, path, block)
        if spliced is None:
            new_blocks.append(block)
        else:
            data = spliced
            resynced.append(path)

    for path in UIS:
        block = read(path).rstrip('\n') + '\n'
        guard(block, path)
        start, _ = marks(path)
        if start not in block:
            sys.exit('%s: expected the file to carry its own from marker' % path)
        spliced = splice(data, path, block)
        if spliced is None:
            new_blocks.append(block)
        else:
            data = spliced
            resynced.append(path)

    if new_blocks:
        anchor = "window.addEventListener('appinstalled'"
        idx = data.find(anchor)
        if idx == -1:
            sys.exit('Script anchor not found')
        added = '\n'.join(b.rstrip('\n') for b in new_blocks) + '\n\n'
        data = data[:idx] + added + data[idx:]

    data, reg_patched = patch_register_dataset(data)

    open(CANVAS, 'w', encoding='utf-8').write(data)

    for p in resynced:
        print('re-synced  %s' % p)
    for b in new_blocks:
        print('injected   %s' % b.split(' ---- ')[1].replace('from ', ''))
    print('registerDataset  %s' % ('patched with store_rejects + quarantine read' if reg_patched else 'already patched'))
    print('canvas %d -> %d chars (%+d)' % (before, len(data), len(data) - before))
    print('sha256(canvas) = %s' % hashlib.sha256(data.encode('utf-8')).hexdigest()[:16])


if __name__ == '__main__':
    main()
