#!/usr/bin/env python3
"""Manually re-sync the js/proof-harness/data-glow-proof-harness-canvas.js
canvas section after editing the source, without touching the engine IIFE
(proposal/verdict/score-claim/receipt/index.js), which is unchanged.
"""
CANVAS = 'canvas/index.html'
UI_SRC = 'js/proof-harness/data-glow-proof-harness-canvas.js'
OPEN = '/* ---- from js/proof-harness/data-glow-proof-harness-canvas.js ---- */'
CLOSE = '/* ---- end js/proof-harness/data-glow-proof-harness-canvas.js ---- */'

def read(p):
    return open(p, encoding='utf-8', errors='replace').read()

data = read(CANVAS)
a = data.find(OPEN)
b = data.find(CLOSE, a)
if a == -1 or b == -1:
    raise SystemExit('markers not found')
b_end = b + len(CLOSE)

new_section = read(UI_SRC)
if not new_section.endswith('\n'):
    new_section += '\n'

new_data = data[:a] + new_section + data[b_end:]
open(CANVAS, 'w', encoding='utf-8').write(new_data)
print('Replaced section: old %d bytes -> new %d bytes' % (b_end - a, len(new_section)))
