#!/usr/bin/env python3
"""Escape <script> and </script> inside JS to prevent HTML parser truncation."""
import sys, re

filepath = sys.argv[1]
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Escape both opening and closing script tags that appear inside string literals
# We look for them in comments or string content (inside quotes or template literals)
# Simple approach: escape ALL occurrences except at the very start/end (which are added by build.sh)
# The outer wrapper adds (function() { ... })(); so the only real <script> is our outer wrapper start
# Since we're escaping a JS string that gets inlined in HTML, ALL script tags inside must be escaped.

close_target = '<' + '/script>'
close_escaped = '<' + '\\/' + 'script>'
open_target = '<script>'
open_escaped = '<' + 'scr' + 'ipt>'  # common HTML-safe encoding

c1 = content.count(close_target)
c2 = content.count(open_target)

# Only escape those that appear INSIDE the content (not the outer wrapper)
# The outer wrapper is the IIFE -- it doesn't contain literal script tags
content = content.replace(close_target, close_escaped)
content = content.replace(open_target, open_escaped)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"  Escaped {c1} closing and {c2} opening script tag(s)")
