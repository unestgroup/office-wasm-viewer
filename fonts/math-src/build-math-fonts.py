#!/usr/bin/env python3
"""Builds the math compatibility fonts in ../math/.

MathType stores a picture (WMF) of every equation. The text records of those pictures name fonts that only exist
where MathType or Office is installed: "MT Extra", "Symbol", "Euclid Math Two" ... Their licences do not allow us to
send the font files to a browser, so we build fonts with the same 8-bit encodings and matching glyph boxes out of an
openly licensed math font (STIX Two Math, SIL OFL 1.1):

  Wasm Math Extra       encoding of MT Extra / Euclid Extra
  Wasm Math Symbol      encoding of Symbol / Euclid Symbol (Adobe Symbol encoding)
  Wasm Math Blackboard  Euclid Math Two: double-struck letters, relations, triangles, set operators
  Wasm Math Script      Euclid Math One: script capitals, circled/squared operators, arrows, harpoons
  Wasm Math Fraktur     Euclid Fraktur: Fraktur letters and the ASCII punctuation of that font

Blackboard, Script, Fraktur and the additions to Extra follow the official encoding tables of Design Science
(encodings/design-science.json: byte code -> MathType character code). A MathType code is resolved to a STIX glyph:
Unicode characters directly, the MathType blackboard/script/Fraktur private use ranges (F0xx/F1xx) to the
mathematical alphanumerics, and a short list of private use codes to the Unicode character with the same meaning
(PUA_ANALOG). Codes that have no such glyph (extenders, loops, embellishments of any width) are left out and listed
in math-fonts.json under "uncovered", never replaced by a glyph of another meaning.

Usage (fontTools and brotli are needed, see README.md):
  python -I build-math-fonts.py --stix <STIXTwoMath-Regular.ttf> --afm afm/Symbol.afm --out ../math

A glyph for the byte code C is mapped at three code points, because renderers decode the bytes of a metafile in
different ways: the Windows-1252 character of C, U+0080+C for the codes that Windows-1252 leaves undefined, and
U+F000+C (the convention of symbol fonts).
"""
import argparse
import json
import math
import os
import sys

from fontTools import agl
from fontTools.fontBuilder import FontBuilder
from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.roundingPen import RoundingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

VERSION = '1.000'
COPYRIGHT = (
    'Glyph outlines derived from STIX Two Math, Copyright 2001-2021 The STIX Fonts Project Authors '
    '(https://github.com/stipub/stixfonts). Re-encoded, scaled and extended by the office-wasm authors, 2026.'
)
LICENSE = 'This Font Software is licensed under the SIL Open Font License, Version 1.1.'
LICENSE_URL = 'https://openfontlicense.org'


# ---------------------------------------------------------------------------------------------------------------
# Glyph construction

class Source:
    def __init__(self, path):
        self.font = TTFont(path)
        self.cmap = self.font.getBestCmap()
        self.glyphs = self.font.getGlyphSet()
        if self.font['head'].unitsPerEm != 1000:
            raise SystemExit('source font must have 1000 units per em')

    def record(self, cp):
        """cp: a code point, or the name of a glyph of the source font."""
        name = cp if isinstance(cp, str) else self.cmap.get(cp)
        if name is None or name not in self.glyphs:
            return None
        rec = DecomposingRecordingPen(self.glyphs)
        self.glyphs[name].draw(rec)
        bounds = BoundsPen(None)
        rec.replay(bounds)
        return rec, bounds.bounds, self.glyphs[name].width

    def first(self, cps):
        for cp in cps:
            got = self.record(cp)
            if got and got[1]:
                return got
        return None


def transformed(rec, t):
    pen = TTGlyphPen(None)
    rec.replay(TransformPen(RoundingPen(pen), t))
    return pen.glyph()


def fit(src, box, mode):
    """Transform that puts the source bounds `src` into the reference box `box`.

    exact:   stretch to the box in both directions (pieces that must join: bracket parts, extenders)
    uniform: one scale, the largest that stays inside the box, centred in the box
    natural: keep the size and the baseline of the source glyph when it is close to the box (within about 15 %),
             so that letters, digits and operators keep one stroke weight and one baseline; only centre it
             horizontally. Otherwise one scale that gives the area of the box, centred in the box.
    """
    sx0, sy0, sx1, sy1 = src
    bx0, by0, bx1, by1 = box
    w, h = sx1 - sx0, sy1 - sy0
    bw, bh = bx1 - bx0, by1 - by0
    if mode == 'exact':
        kx, ky = bw / w, bh / h
    elif mode == 'natural':
        ratios = [bw / w] if h < 0.25 * w else [bh / h] if w < 0.25 * h else [bw / w, bh / h]
        if all(0.85 <= r <= 1.18 for r in ratios):
            return Transform(1, 0, 0, 1, (bx0 + bx1) / 2 - (sx0 + sx1) / 2, 0)
        kx = ky = math.sqrt((bw / w) * (bh / h)) if len(ratios) == 2 else ratios[0]
    else:
        if h < 0.25 * w:
            k = bw / w
        elif w < 0.25 * h:
            k = bh / h
        else:
            k = min(bw / w, bh / h)
        kx = ky = k
    dx = (bx0 + bx1) / 2 - kx * (sx0 + sx1) / 2
    dy = (by0 + by1) / 2 - ky * (sy0 + sy1) / 2
    return Transform(kx, 0, 0, ky, dx, dy)


def polygon(*contours):
    pen = TTGlyphPen(None)
    for contour in contours:
        pen.moveTo(contour[0])
        for p in contour[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


def quad(p0, p1, p2, n=12):
    out = []
    for i in range(n + 1):
        t = i / n
        a, b, c = (1 - t) ** 2, 2 * t * (1 - t), t * t
        out.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]))
    return out


def stroke(points, half):
    """Closed outline (clockwise for a left-to-right line) around a centre line, butt ends."""
    pts = [points[0]]
    for p in points[1:]:
        if math.dist(p, pts[-1]) > 1e-6:
            pts.append(p)
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        ax, ay = pts[max(i - 1, 0)]
        bx, by = pts[min(i + 1, len(pts) - 1)]
        d = math.hypot(bx - ax, by - ay)
        nx, ny = -(by - ay) / d, (bx - ax) / d
        left.append((round(x + nx * half), round(y + ny * half)))
        right.append((round(x - nx * half), round(y - ny * half)))
    return left + right[::-1]


def flip_y(points):
    return [(x, -y) for x, y in points]


def mirror_x(points, width):
    return [(width - x, y) for x, y in points][::-1]


# ---------------------------------------------------------------------------------------------------------------
# Encodings

def code_points(code):
    """Unicode code points at which the glyph of byte `code` is mapped."""
    cps = {0xF000 + code}
    try:
        cps.add(ord(bytes([code]).decode('cp1252')))
    except UnicodeDecodeError:
        pass
    if code >= 0x80:
        cps.add(code)  # Latin-1 reading of the byte
    return cps


# MT Extra: (advance, box) of the font that ships with Office (metrics only, for layout compatibility) and the
# Unicode character of each code (https://www-archive.mozilla.org/projects/mathml/fonts/encoding/mtextra, completed
# with the characters found in MathType 6/7 documents). 'exact' entries are stretched to the box.
MT_EXTRA = {
    0x23: (333, (16, 507, 243, 678), [0x0300], 'uniform'),
    0x24: (333, (11, 507, 323, 674), [0x0302], 'uniform'),
    0x25: (333, (1, 532, 332, 638), [0x0303], 'uniform'),
    0x26: (333, (116, 523, 216, 623), [0x0307], 'uniform'),
    0x28: (410, (0, 0, 410, 117), [0x2323], 'exact'),
    0x29: (410, (0, 0, 410, 117), [0x2322], 'exact'),
    0x3C: (640, (60, 1, 579, 521), [0x25C3], 'uniform'),
    0x3E: (640, (61, 1, 580, 521), [0x25B9], 'uniform'),
    0x43: (823, (25, -101, 803, 751), [0x2210], 'uniform'),
    0x44: (549, (24, -18, 548, 739), [0x019B], 'uniform'),
    0x49: (660, (30, -107, 628, 752), [0x2229], 'uniform'),
    0x4B: (1000, (112, -17, 890, 95), [0x2026], 'uniform'),
    0x4C: (1000, (112, 204, 890, 316), [0x22EF], 'uniform'),
    0x4D: (333, (112, -17, 224, 761), [0x22EE], 'uniform'),
    0x4E: (1000, (112, -17, 890, 761), [0x22F0], 'uniform'),
    0x4F: (1000, (112, -17, 890, 761), [0x22F1], 'uniform'),
    0x51: (863, (163, 0, 701, 478), [0x2235], 'uniform'),
    0x55: (660, (30, -107, 628, 752), [0x222A], 'uniform'),
    0x60: (247, (31, 458, 232, 734), [0x2035], 'uniform'),
    0x61: (987, (25, -15, 959, 511), [0x21A6], 'uniform'),
    0x62: (685, (81, -202, 607, 798), [0x2195], 'uniform'),
    0x63: (675, (75, -198, 605, 798), [0x21D5], 'uniform'),
    0x66: (600, (34, 3, 575, 521), [0x227B], 'uniform'),
    0x68: (500, (23, -11, 472, 684), [0x210F], 'uniform'),
    0x6C: (434, (23, -13, 397, 676), [0x2113], 'uniform'),
    0x6D: (549, (10, -1, 539, 644), [0x2213], 'uniform'),
    0x6F: (400, (50, 110, 350, 409), [0x2218], 'uniform'),
    0x70: (600, (28, 3, 569, 521), [0x227A], 'uniform'),
    0x7B: (856, (0, -170, 856, 169), [0x23DF], 'exact'),
    0x7D: (856, (0, -169, 856, 170), [0x23DE], 'exact'),
    # Not in the Office font; found in MathType documents. The box of the wide hat is our own choice.
    0xA1: (None, None, [0x211D], 'copy'),
    0xA5: (None, None, [0x2115], 'copy'),
    0xB5: (500, (60, 390, 440, 560), [0x0302], 'exact'),
}


def mt_extra_drawn():
    """Embellishment parts drawn here: MathType overlaps them to build arrows and braces of any length."""
    w, t, hh = 410, 18, 70  # advance, half thickness of the line, half height of the arrow head
    back, notch = 265, 300
    g = {}
    g[0x75] = (w, polygon([(0, t), (w, t), (w, -t), (0, -t)]))
    right = [(0, t), (notch, t), (back, hh), (w, 0), (back, -hh), (notch, -t), (0, -t)]
    g[0x72] = (w, polygon(right))
    g[0x73] = (w, polygon(mirror_x(right, w)))
    g[0x74] = (w, polygon([(0, 0), (w - back, hh), (w - notch, t), (notch, t), (back, hh), (w, 0),
                            (back, -hh), (notch, -t), (w - notch, -t), (w - back, -hh)]))
    harpoon = [(0, t), (notch, t), (back, hh), (w, -t), (0, -t)]
    g[0x76] = (w, polygon(harpoon))
    g[0x77] = (w, polygon(mirror_x(harpoon, w)))

    # Horizontal brace in three parts plus an extender. 0x31-0x33: ends up, point down. 0x36-0x38: the reverse.
    half = 27
    left = quad((half, 211), (half, 0), (330, 0)) + [(1001, 0)]
    mid = [(0, 0)] + quad((240, 0), (500, 0), (510, -214 + half)) + quad((510, -214 + half), (520, 0), (780, 0)) + [(1020, 0)]
    right_part = [(0, 0)] + quad((666, 0), (996 - half, 0), (996 - half, 211))
    for base, f in ((0x31, lambda p: p), (0x36, flip_y)):
        parts = [(1001, f(left)), (1020, f(mid)), (996, f(right_part))]
        for i, (adv, line) in enumerate(parts):
            outline = stroke(line, half)
            if f is flip_y:
                outline = outline[::-1]
            g[base + i] = (adv, polygon(outline))
    g[0x34] = (1001, polygon([(0, half), (1015, half), (1015, -half), (0, -half)]))
    return g


# ---------------------------------------------------------------------------------------------------------------
# Encodings of Design Science (byte code -> MathType character code)

ENCODINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'encodings', 'design-science.json')

# Private use codes of MathType whose Unicode counterpart has the same meaning (the shape may differ slightly: the
# Euclid glyph is a variant, e.g. "less-than but not equal to" with vertical strokes).
PUA_ANALOG = {
    0xE90B: [0x2287], 0xE90C: [0x2286], 0xE922: [0x22DA], 0xE92D: [0x22DB], 0xE92E: [0x2223], 0xE92F: [0x2225],
    0xE932: [0x2A85], 0xE933: [0x2A86], 0xE93A: [0x227E], 0xE93B: [0x227F], 0xE98F: [0x22C5],
    0xEA06: [0x2270], 0xEA07: [0x2271], 0xEA0B: [0x2289], 0xEA0C: [0x2288], 0xEA0E: [0x2271], 0xEA10: [0x2270],
    0xEA2E: [0x2224], 0xEA2F: [0x2226], 0xEA32: [0x2A89], 0xEA33: [0x2A8A], 0xEA34: [0x2268], 0xEA35: [0x2269],
    0xEA3A: [0x22E8], 0xEA3B: [0x22E9], 0xEA3C: [0x2AB5], 0xEA3D: [0x2AB6], 0xEA3E: [0x22E0], 0xEA3F: [0x22E1],
    0xEA40: [0x2AB5], 0xEA41: [0x2AB6], 0xEA42: [0x2288], 0xEA43: [0x2289], 0xEA44: [0x228A], 0xEA45: [0x228B],
    0xEA46: [0x2288], 0xEA47: [0x2289],
    0xEB05: [0x2922], 0xEB06: [0x2921], 0xEB19: [0x21C1], 0xEB1A: [0x21BD],
    0xED02: [0x0237],
}

# Codes left to the code that draws them (extenders and parts that MathType stacks) or that have no usable glyph.
EXTRA_SKIP = {0x6E, 0x88}


def resolve(mt):
    """Candidates (code points) of the source font for a MathType character code, or None."""
    if 0xF080 <= mt <= 0xF098:
        return [0x1D538 + mt - 0xF080]             # blackboard capitals A-Y (Z is U+2124)
    if mt == 0xF0A4:
        return [0x1D55C]                           # blackboard small k
    if 0xF100 <= mt <= 0xF119:
        return [0x1D49C + mt - 0xF100]             # script capitals
    if 0xF000 <= mt <= 0xF018:
        return [0x1D504 + mt - 0xF000]             # Fraktur capitals
    if 0xF01A <= mt <= 0xF033:
        return [0x1D51E + mt - 0xF01A]             # Fraktur small letters
    if mt in PUA_ANALOG:
        return PUA_ANALOG[mt]
    if 0xE000 <= mt <= 0xF8FF or mt in (0xFFFD, 0xFE68):
        return None
    return [mt]


def encoded_glyphs(src, table, skip=()):
    """{code: (advance, glyph)} for every code of the table that resolves; second result: codes left out."""
    glyphs, uncovered = {}, []
    for key, (mt, _) in sorted(table.items()):
        code = int(key, 16)
        if code in skip or code in (0x20, 0xA0):
            continue
        cps = resolve(int(mt, 16))
        got = src.first(cps) if cps else None
        if not got:
            uncovered.append('%02X' % code)
            continue
        rec, _, width = got
        glyphs[code] = (width, transformed(rec, Transform()))
    return glyphs, uncovered


# Symbol: names of Symbol.afm that the Adobe glyph list maps to the private use area or to a compatibility character.
SYMBOL_UNICODE = {
    'Omega': [0x03A9], 'Delta': [0x0394], 'mu': [0x03BC], 'Euro': [0x20AC],
    'angleleft': [0x27E8, 0x2329], 'angleright': [0x27E9, 0x232A],
    'registerserif': [0x00AE], 'copyrightserif': [0x00A9], 'trademarkserif': [0x2122],
    'registersans': [0x00AE], 'copyrightsans': [0x00A9], 'trademarksans': [0x2122],
    'parenlefttp': [0x239B], 'parenleftex': [0x239C], 'parenleftbt': [0x239D],
    'parenrighttp': [0x239E], 'parenrightex': [0x239F], 'parenrightbt': [0x23A0],
    'bracketlefttp': [0x23A1], 'bracketleftex': [0x23A2], 'bracketleftbt': [0x23A3],
    'bracketrighttp': [0x23A4], 'bracketrightex': [0x23A5], 'bracketrightbt': [0x23A6],
    'bracelefttp': [0x23A7], 'braceleftmid': [0x23A8], 'braceleftbt': [0x23A9], 'braceex': [0x23AA],
    'bracerighttp': [0x23AB], 'bracerightmid': [0x23AC], 'bracerightbt': [0x23AD],
    'integraltp': [0x2320], 'integralex': [0x23AE], 'integralbt': [0x2321],
    'integral': ['uni222B.up', 0x222B],  # upright form: the Symbol integral is narrow
}
SYMBOL_EXACT = {n for n in SYMBOL_UNICODE if n.endswith(('tp', 'ex', 'bt', 'mid'))} | {'integral'}
SYMBOL_RECT = {'radicalex', 'arrowvertex', 'arrowhorizex'}  # straight extenders: the box itself
SYMBOL_SKIP = {'apple', 'space'}


def read_afm(path):
    chars = []
    with open(path, encoding='latin-1') as f:
        for line in f:
            if not line.startswith('C '):
                continue
            fields = {}
            for part in line.split(';'):
                part = part.strip()
                if part:
                    key, _, value = part.partition(' ')
                    fields[key] = value.strip()
            code = int(fields['C'])
            if code < 0:
                continue
            chars.append((code, fields['N'], int(fields['WX']), tuple(int(v) for v in fields['B'].split())))
    return chars


# ---------------------------------------------------------------------------------------------------------------
# Font assembly

def build(family, file_stem, glyphs, out_dir, ascent, descent, encoding_note):
    """glyphs: {code: (advance, glyph)}"""
    order = ['.notdef', 'space']
    table = {'.notdef': polygon([(50, 0), (50, 700), (450, 700), (450, 0)], [(100, 50), (400, 50), (400, 650), (100, 650)]),
             'space': TTGlyphPen(None).glyph()}
    metrics = {'.notdef': (500, 50), 'space': (250, 0)}
    cmap = {0x20: 'space', 0xA0: 'space', 0xF020: 'space'}
    for code in sorted(glyphs):
        advance, glyph = glyphs[code]
        name = 'c%02X' % code
        order.append(name)
        table[name] = glyph
        glyph.recalcBounds(None)
        metrics[name] = (advance, glyph.xMin if glyph.numberOfContours else 0)
        for cp in code_points(code):
            cmap[cp] = name

    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(table)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ascent, descent=-descent)
    fb.setupNameTable({
        'copyright': COPYRIGHT,
        'familyName': family,
        'styleName': 'Regular',
        'uniqueFontIdentifier': '%s %s' % (family, VERSION),
        'fullName': family,
        'version': 'Version ' + VERSION,
        'psName': family.replace(' ', '') + '-Regular',
        'description': encoding_note,
        'licenseDescription': LICENSE,
        'licenseInfoURL': LICENSE_URL,
    })
    fb.setupOS2(sTypoAscender=ascent, sTypoDescender=-descent, sTypoLineGap=0, usWinAscent=ascent,
                usWinDescent=descent, achVendID='OWSM', fsType=0)
    fb.setupPost()
    fb.font['head'].fontRevision = float(VERSION)
    ttf = os.path.join(out_dir, file_stem + '.ttf')
    fb.save(ttf)
    web = TTFont(ttf)
    web.flavor = 'woff2'
    web.save(os.path.join(out_dir, file_stem + '.woff2'))
    return {'family': family, 'ttf': file_stem + '.ttf', 'woff2': file_stem + '.woff2',
            'codes': ['%02X' % c for c in sorted(glyphs)]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stix', required=True, help='STIXTwoMath-Regular.ttf (TrueType outlines)')
    ap.add_argument('--afm', required=True, help='Adobe Symbol.afm')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    src = Source(args.stix)
    os.makedirs(args.out, exist_ok=True)
    missing = []
    report = {}
    with open(ENCODINGS, encoding='utf-8') as f:
        tables = json.load(f)['tables']

    # --- Wasm Math Extra
    extra = dict(mt_extra_drawn())
    for code, (advance, box, cps, mode) in MT_EXTRA.items():
        got = src.first(cps)
        if not got:
            missing.append('extra %02X' % code)
            continue
        rec, bounds, width = got
        if mode == 'copy':
            extra[code] = (width, transformed(rec, Transform()))
        else:
            extra[code] = (advance, transformed(rec, fit(bounds, box, mode)))
    more, uncovered = encoded_glyphs(src, tables['mtextra'], EXTRA_SKIP)
    for code, glyph in more.items():
        extra.setdefault(code, glyph)
    report['extra'] = build('Wasm Math Extra', 'WasmMathExtra', extra, args.out, 800, 214,
                            'Encoding of MT Extra (MathType).')
    report['extra']['uncovered'] = [c for c in uncovered if int(c, 16) not in extra]

    # --- Wasm Math Symbol
    symbol = {}
    for code, name, advance, box in read_afm(args.afm):
        if name in SYMBOL_SKIP:
            continue
        if name in SYMBOL_RECT:
            x0, y0, x1, y1 = box
            symbol[code] = (advance, polygon([(x0, y1), (x1, y1), (x1, y0), (x0, y0)]))
            continue
        cps = SYMBOL_UNICODE.get(name) or [ord(c) for c in agl.toUnicode(name)][:1]
        got = src.first(cps)
        if not got:
            missing.append('symbol %02X %s' % (code, name))
            continue
        rec, bounds, _ = got
        symbol[code] = (advance, transformed(rec, fit(bounds, box, 'exact' if name in SYMBOL_EXACT else 'natural')))
    report['symbol'] = build('Wasm Math Symbol', 'WasmMathSymbol', symbol, args.out, 1005, 220,
                             'Adobe Symbol encoding.')

    # --- Euclid Math Two, Euclid Math One, Euclid Fraktur: from the official tables
    for key, family, stem, note in (
            ('eumat2', 'Wasm Math Blackboard', 'WasmMathBlackboard', 'Encoding of Euclid Math Two (MathType).'),
            ('eumat1', 'Wasm Math Script', 'WasmMathScript', 'Encoding of Euclid Math One (MathType).'),
            ('eufrak', 'Wasm Math Fraktur', 'WasmMathFraktur', 'Encoding of Euclid Fraktur (MathType).')):
        glyphs, uncovered = encoded_glyphs(src, tables[key])
        name = {'eumat2': 'blackboard', 'eumat1': 'script', 'eufrak': 'fraktur'}[key]
        report[name] = build(family, stem, glyphs, args.out, 800, 214, note)
        report[name]['uncovered'] = uncovered

    with open(os.path.join(args.out, 'math-fonts.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'version': VERSION, 'fonts': report}, f, indent=1)
        f.write('\n')
    for key, info in report.items():
        print('%-10s %-22s %3d glyphs  ttf %6d B  woff2 %6d B  uncovered %s' % (
            key, info['family'], len(info['codes']),
            os.path.getsize(os.path.join(args.out, info['ttf'])), os.path.getsize(os.path.join(args.out, info['woff2'])),
            ' '.join(info.get('uncovered', [])) or '-'))
    if missing:
        print('MISSING in source font: ' + ', '.join(missing))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
