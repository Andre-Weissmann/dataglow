#!/usr/bin/env python3
"""
Injection script for PR #553 -- Gap-Fill Pack.
Injects 4 new capability modules right before the appinstalled listener:
  1. js/ml/onnx-inference.js
  2. js/pipeline/sw-scheduler.js
  3. js/export/signed-html-export.js
  4. js/ml/model-registry.js
"""
import sys

CANVAS_PATH = '/home/user/workspace/dataglow-live-rebuild/canvas/index.html'
MODULES_DIR = '/home/user/workspace/dataglow-live-rebuild/build_modules'

INJECTION_MARKER = "window.addEventListener('appinstalled', function() {"

module_files = [
    'module1_onnx_inference.js',
    'module2_sw_scheduler.js',
    'module3_signed_html_export.js',
    'module4_model_registry.js',
]

def main():
    with open(CANVAS_PATH, 'r', errors='replace') as f:
        canvas = f.read()

    idx = canvas.find(INJECTION_MARKER)
    if idx == -1:
        print('ERROR: injection marker not found')
        sys.exit(1)

    combined_modules = []
    for mf in module_files:
        with open(f'{MODULES_DIR}/{mf}', 'r', errors='replace') as f:
            combined_modules.append(f.read())

    injection_block = (
        '\n\n/* ================================================================\n'
        '   PR #553: Gap-Fill Pack -- ONNX inference, pipeline scheduler,\n'
        '   signed HTML export, model registry\n'
        '================================================================ */\n\n'
        + '\n\n'.join(combined_modules)
        + '\n\n'
    )

    new_canvas = canvas[:idx] + injection_block + canvas[idx:]

    with open(CANVAS_PATH, 'w', errors='replace') as f:
        f.write(new_canvas)

    print('Injection complete.')
    print('Old size:', len(canvas))
    print('New size:', len(new_canvas))
    print('Delta:', len(new_canvas) - len(canvas))

if __name__ == '__main__':
    main()
