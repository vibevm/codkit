#!/usr/bin/env python3
# Copyright (c) 2026 Oleg Chirukhin
# Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
# Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
# SPDX-License-Identifier: UPL-1.0
#
# Regenerates the codkit logo assets from one geometry: codkit.svg (icon with background),
# codkit-mark.svg (mark only), codkit.png (512) and codkit-128.png. Requires Pillow.
# Usage: make-logo.py <output-dir>   (dev tool; the shipped assets are committed bytes)
from PIL import Image, ImageDraw
import os, sys

SIZE = 512
BG_TOP, BG_BOTTOM = (0x2a, 0x49, 0x7a), (0x14, 0x20, 0x3a)   # navy gradient
AMBER = (0xff, 0xb5, 0x47)                                   # brackets
ICE   = (0x9f, 0xd8, 0xff)                                   # delta
NAVY  = (0x1c, 0x2a, 0x49)                                   # delta in the mark-only variant
R_BG = 112
STROKE = 38          # bracket stroke width
# brackets: [ and ] as polylines
LEFT  = [(178, 150), (124, 150), (124, 362), (178, 362)]
RIGHT = [(334, 150), (388, 150), (388, 362), (334, 362)]
# delta: triangle with rounded corners (drawn as fill + round-joined outline of width DW)
APEX, BL, BR = (256, 168), (186, 330), (326, 330)
DW = 20

HEADER = """<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->"""

def hexc(c): return '#%02x%02x%02x' % c
def pts(p): return ' '.join(f'{x},{y}' for x, y in p)

def svg(with_bg):
    delta_fill = ICE if with_bg else NAVY
    bg = ''
    if with_bg:
        bg = f'''  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{hexc(BG_TOP)}"/>
      <stop offset="1" stop-color="{hexc(BG_BOTTOM)}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="{SIZE}" height="{SIZE}" rx="{R_BG}" fill="url(#bg)"/>
'''
    tri = f'{APEX[0]},{APEX[1]} {BL[0]},{BL[1]} {BR[0]},{BR[1]}'
    return f'''<?xml version="1.0" encoding="UTF-8"?>
{HEADER}
<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="codkit">
  <title>codkit — a delta held inside its markers</title>
{bg}  <g fill="none" stroke="{hexc(AMBER)}" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="{pts(LEFT)}"/>
    <polyline points="{pts(RIGHT)}"/>
  </g>
  <polygon points="{tri}" fill="{hexc(delta_fill)}" stroke="{hexc(delta_fill)}" stroke-width="{DW}" stroke-linejoin="round"/>
</svg>
'''

def render(size, with_bg, out):
    SS = 4; W = SIZE * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = SS
    if with_bg:
        # vertical gradient inside a rounded-square mask
        grad = Image.new('RGBA', (W, W), (0, 0, 0, 0))
        gd = ImageDraw.Draw(grad)
        for y in range(W):
            t = y / (W - 1)
            c = tuple(round(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3)) + (255,)
            gd.line([(0, y), (W, y)], fill=c)
        mask = Image.new('L', (W, W), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=R_BG * s, fill=255)
        img.paste(grad, (0, 0), mask)
        d = ImageDraw.Draw(img)
    delta_fill = ICE if with_bg else NAVY
    for line in (LEFT, RIGHT):
        p = [(x * s, y * s) for x, y in line]
        d.line(p, fill=AMBER + (255,), width=STROKE * s, joint='curve')
        for x, y in (p[0], p[-1]):
            r = STROKE * s / 2
            d.ellipse([x - r, y - r, x + r, y + r], fill=AMBER + (255,))
    tri = [(x * s, y * s) for x, y in (APEX, BL, BR)]
    d.polygon(tri, fill=delta_fill + (255,))
    d.line(tri + [tri[0]], fill=delta_fill + (255,), width=DW * s, joint='curve')
    for x, y in tri:
        r = DW * s / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=delta_fill + (255,))
    img = img.resize((size, size), Image.LANCZOS)
    img.save(out, 'PNG', optimize=True)
    return out

out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
open(os.path.join(out, 'codkit.svg'), 'w', encoding='utf-8').write(svg(True))
open(os.path.join(out, 'codkit-mark.svg'), 'w', encoding='utf-8').write(svg(False))
render(512, True, os.path.join(out, 'codkit.png')); render(128, True, os.path.join(out, 'codkit-128.png'))
print('written to', out)
