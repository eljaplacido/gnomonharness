#!/usr/bin/env python3
"""
Render captured ANSI terminal output to a PNG that looks like a terminal.

Written because gnomon has no screenshot: the only image in a 1,900-line README
is a stock photograph of a sundial, for a project whose entire value is the
interactive terminal experience. asciinema/agg/vhs are not installed on this
machine and PIL is, so this renders the real captured bytes rather than a
mock-up: every character below came out of `gnomon prompt` under a pty.

Supersampled 2x and downscaled, because thin box-drawing at 1x looks broken.
"""
import re
import sys
from PIL import Image, ImageDraw, ImageFont

SCALE = 2
FONT_PX = 15 * SCALE
LINE_H = 21 * SCALE
PAD_X = 18 * SCALE
PAD_TOP = 40 * SCALE          # room for the title bar
PAD_BOT = 16 * SCALE
CHROME_H = 30 * SCALE

REG = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
BLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

BG = (13, 17, 23)
CHROME = (22, 27, 34)
CHROME_LINE = (48, 54, 61)
FG = (201, 209, 217)
TITLE = (125, 133, 144)

# xterm-ish, tuned for legibility on this ground
PAL = {
    30: (72, 79, 88),    31: (255, 123, 114), 32: (86, 211, 100),
    33: (232, 179, 88),  34: (110, 168, 254), 35: (210, 168, 255),
    36: (57, 197, 207),  37: (176, 185, 196), 90: (110, 118, 129),
    91: (255, 166, 158), 92: (126, 231, 135), 93: (242, 204, 96),
    94: (140, 190, 255), 95: (224, 190, 255), 96: (100, 216, 224),
    97: (240, 246, 252),
}


def parse_lines(text):
    out = []
    sgr = re.compile(r"\x1b\[([0-9;]*)m")
    for raw in text.split("\n"):
        spans = []
        col, bold, dim = None, False, False
        pos = 0
        for m in sgr.finditer(raw):
            chunk = raw[pos:m.start()]
            if chunk:
                spans.append((chunk, col, bold, dim))
            codes = [c for c in m.group(1).split(";") if c != ""] or ["0"]
            i = 0
            while i < len(codes):
                c = int(codes[i])
                if c == 0:
                    col, bold, dim = None, False, False
                elif c == 1:
                    bold = True
                elif c == 2:
                    dim = True
                elif c == 22:
                    bold = dim = False
                elif c == 39:
                    col = None
                elif c in PAL:
                    col = PAL[c]
                elif c == 38 and i + 4 < len(codes) and codes[i + 1] == "2":
                    col = (int(codes[i + 2]), int(codes[i + 3]), int(codes[i + 4]))
                    i += 4
                i += 1
            pos = m.end()
        tail = raw[pos:]
        if tail:
            spans.append((tail, col, bold, dim))
        out.append(spans)
    return out


def main(src, dst, title):
    text = open(src, encoding="utf-8").read().rstrip("\n")
    rows = parse_lines(text)

    reg = ImageFont.truetype(REG, FONT_PX)
    bld = ImageFont.truetype(BLD, FONT_PX)
    cw = reg.getlength("M")

    widest = max((sum(len(t) for t, *_ in r) for r in rows), default=80)
    w = int(PAD_X * 2 + cw * widest)
    h = int(PAD_TOP + LINE_H * len(rows) + PAD_BOT)

    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    # title bar
    d.rectangle([0, 0, w, CHROME_H], fill=CHROME)
    d.line([(0, CHROME_H), (w, CHROME_H)], fill=CHROME_LINE, width=SCALE)
    r = 5 * SCALE
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = PAD_X + i * (r * 3.4) + r
        cy = CHROME_H / 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    tf = ImageFont.truetype(REG, int(FONT_PX * 0.82))
    d.text((w / 2, CHROME_H / 2), title, font=tf, fill=TITLE, anchor="mm")

    # Draw on a CHARACTER GRID, one glyph per cell, rather than advancing by the
    # measured width of a whole span. DejaVu's box-drawing glyphs do not all
    # carry the same advance as `M`, so span-advancing sheared the banner:
    # `\u2554\u2550\u2550\u2557` and the `\u2551` below it landed on different columns. A terminal
    # places every cell on the grid; so does this now.
    y = PAD_TOP
    for spans in rows:
        col_i = 0
        for t, colr, bold, dim in spans:
            c = colr or FG
            if dim and not colr:
                c = PAL[90]
            f = bld if bold else reg
            for ch in t:
                if ch != " ":
                    d.text((PAD_X + cw * col_i, y), ch, font=f, fill=c)
                col_i += 1
        y += LINE_H

    img = img.resize((w // SCALE, h // SCALE), Image.LANCZOS)
    img.save(dst, optimize=True)
    print(f"{dst}  {img.width}x{img.height}  {len(rows)} lines")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "gnomon")
