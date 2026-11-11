#!/usr/bin/env python3
"""Makes the patched copy of the original ABC fonts (.VnTime, .VnTimeH) that the font pack installs: ../vn-orig/patched/.

The originals in ../vn-orig/ stay untouched (checksums in SOURCE.md). Two things are changed:

1. cmap: TCVN3 byte 0xAD (u with horn) is U+00AD in a document. Editors treat U+00AD as an invisible soft hyphen
   and never ask the font for it. The glyph is also mapped at U+F0AD (symbol convention, as in ../vn/); the viewer
   rewrites U+00AD to U+F0AD in the runs that use these fonts (x2t/prepare-package.mjs).
2. Missing glyphs are copied from the open rebuild in ../vn/ (Tinos outlines, same units per em): TCVN3 letters
   (VHTIME byte B7, VHTIMEBI bytes A4-A6) and the typographic punctuation Word inserts on its own (dashes, curly
   quotes, ellipsis, bullet, euro) that some of the originals lack. Without them the editor shows nothing there.

Usage (fontTools needed): python -I patch-vn-originals.py <vn-orig dir> <vn dir with the OFL rebuild> <out dir>
"""
import json
import os
import shutil
import sys

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

SHY = 0x00AD
ALIAS = 0xF0AD
PUNCTUATION = [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x20AC]
STYLE_OF = {'': 'Regular', 'B': 'Bold', 'I': 'Italic', 'BI': 'BoldItalic'}


def donor_name(file):
    """VNTIMEBI.TTF -> VnTime-BoldItalic.ttf, VHTIME.TTF -> VnTimeH-Regular.ttf"""
    stem = file.rsplit('.', 1)[0].upper()
    family = 'VnTimeH' if stem.startswith('VHTIME') else 'VnTime'
    return '%s-%s.ttf' % (family, STYLE_OF[stem[len('VHTIME'):]])


def patch(src, donor_path, wanted, dst):
    font = TTFont(src)
    cmap = font.getBestCmap()
    if SHY not in cmap:
        raise SystemExit(src + ': no glyph at U+00AD')
    donor = TTFont(donor_path)
    if donor['head'].unitsPerEm != font['head'].unitsPerEm:
        raise SystemExit('units per em differ: ' + src)
    added = {}
    for cp in wanted:
        if cp in cmap or cp not in donor.getBestCmap():
            continue
        char = chr(cp)
        dname = donor.getBestCmap()[cp]
        pen = DecomposingRecordingPen(donor.getGlyphSet())
        donor.getGlyphSet()[dname].draw(pen)
        tt = TTGlyphPen(None)
        pen.replay(tt)
        name = 'uni%04X' % cp
        order = font.getGlyphOrder() + [name]
        font.setGlyphOrder(order)
        font['glyf'].glyphOrder = order
        font['glyf'].glyphs[name] = tt.glyph()
        font['hmtx'].metrics[name] = donor['hmtx'][dname]
        added[cp] = name
    for table in font['cmap'].tables:
        if table.format == 4:  # Windows Unicode, Unicode and symbol (3,0) tables; the Mac table (format 0) only holds 0-255
            table.cmap.update(added)
            table.cmap[ALIAS] = cmap[SHY]
    font['maxp'].numGlyphs = len(font.getGlyphOrder())
    font.save(dst)
    return [hex(c) for c in added]


def main():
    orig, vn, out = sys.argv[1:4]
    here = os.path.dirname(os.path.abspath(__file__))
    codes = json.load(open(os.path.join(here, 'tcvn3.json'), encoding='utf-8'))['codes']
    letters = [ord(bytes([int(k, 16)]).decode('cp1252')) for k in codes]
    os.makedirs(out, exist_ok=True)
    report = {}
    for name in sorted(os.listdir(orig)):
        if not name.lower().endswith('.ttf'):
            continue
        report[name] = patch(os.path.join(orig, name), os.path.join(vn, donor_name(name)), letters + PUNCTUATION, os.path.join(out, name))
    shutil.copy(os.path.join(orig, 'vn-fonts.json'), os.path.join(out, 'vn-fonts.json'))
    print(json.dumps(report))


main()
