#!/usr/bin/env python3
"""Builds the Vietnamese legacy-encoding fonts in ../vn/: ".VnTime" and ".VnTimeH" (TCVN3 / "ABC" fonts).

Old Vietnamese documents (.doc/.docx written with Unikey/VietKey in TCVN3 mode) store Vietnamese letters as the
Latin-1 characters of the TCVN3 byte codes (for example "Hµ Néi" for "Hà Nội") and rely on the fonts ".VnTime"
(mixed case) and ".VnTimeH" (all capitals) to show them. Those fonts are not freely redistributable, so these
substitutes put the right glyphs of Tinos (SIL OFL 1.1, metric compatible with Times New Roman, full Vietnamese
coverage) at the TCVN3 byte codes. The family names are the legacy names, because documents look the fonts up by name.

  .VnTime   byte -> small letter (A1-A7 -> the capitals A-breve .. D-stroke), ASCII unchanged
  .VnTimeH  every byte and every ASCII letter shows the capital (tone marks on capitals work through this font)

The byte table is tcvn3.json (facts about the encoding). Each byte code C is mapped at the Latin-1 character of C and
at U+F000+C (symbol convention); every other character keeps its Tinos glyph.

Usage (fontTools and brotli are needed): python -I build-vn-fonts.py --tinos <dir with Tinos-*.ttf> --out ../vn
"""
import argparse
import json
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

STYLES = {  # file suffix -> (style name, bold, italic)
    'Regular': ('Regular', False, False),
    'Bold': ('Bold', True, False),
    'Italic': ('Italic', False, True),
    'BoldItalic': ('Bold Italic', True, True),
}
FAMILIES = {'VnTime': '.VnTime', 'VnTimeH': '.VnTimeH'}
KEEP = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x250)) + [0x2BC, 0x2C6, 0x2C7, 0x2D8, 0x2D9, 0x2DA, 0x2DB, 0x2DC, 0x2DD]
        + list(range(0x300, 0x370)) + list(range(0x1EA0, 0x1F00)) + list(range(0x2010, 0x2050)) + [0x20AB, 0x20AC, 0x2116, 0x2122, 0x2212]
        + list(range(0xF0A0, 0x10000 if False else 0xF100)))
COPYRIGHT_NOTE = ('Derived from Tinos (Copyright 2010 Google Inc., SIL Open Font License 1.1): glyphs re-encoded to TCVN3 '
                  'by the office-wasm authors, 2026.')


def build(src_path, family_key, style_key, table, out_dir):
    font = TTFont(src_path)
    cmap = font.getBestCmap()
    capital_mode = family_key == 'VnTimeH'
    new = {}
    for key, letters in table.items():
        code = int(key, 16)
        if len(letters) == 1:
            letter = letters[0]
            if capital_mode:
                letter = letter.upper()
        else:
            letter = letters[0] if capital_mode else letters[1]
        glyph = cmap.get(ord(letter))
        if glyph is None:
            raise SystemExit('Tinos has no glyph for %s (byte %s)' % (letter, key))
        new[code] = glyph
    if capital_mode:
        for c in range(ord('a'), ord('z') + 1):
            new[c] = cmap[c - 32]
    for table_ in font['cmap'].tables:
        if not table_.isUnicode():
            continue
        for code, glyph in new.items():
            if code >= 0x80:
                table_.cmap[code] = glyph
                if table_.format != 4 or True:
                    table_.cmap[0xF000 + code] = glyph
            else:
                table_.cmap[code] = glyph
    # subset: Latin, Vietnamese, punctuation; keep layout tables so kerning stays
    opts = subset.Options()
    opts.layout_features = ['kern']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.hinting = True
    opts.legacy_kern = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=set(KEEP) | set(new) | {0xF000 + c for c in new})
    sub.subset(font)

    family = FAMILIES[family_key]
    style, bold, italic = STYLES[style_key]
    names = font['name']
    names.names = [n for n in names.names if n.nameID not in (1, 2, 3, 4, 6, 16, 17, 21, 22, 10)]
    ps = family.lstrip('.') + '-' + style_key
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        names.setName(family, 1, pid, eid, lid)
        names.setName(style, 2, pid, eid, lid)
        names.setName('%s %s 1.0' % (family, style), 3, pid, eid, lid)
        names.setName('%s %s' % (family, style) if style != 'Regular' else family, 4, pid, eid, lid)
        names.setName(ps, 6, pid, eid, lid)
        names.setName(COPYRIGHT_NOTE, 10, pid, eid, lid)
    os2 = font['OS/2']
    os2.achVendID = 'OWSM'
    os2.fsType = 0
    out = os.path.join(out_dir, '%s-%s.ttf' % (family_key, style_key))
    font.save(out)
    return out, len(new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tinos', required=True)
    ap.add_argument('--table', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tcvn3.json'))
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    with open(args.table, encoding='utf-8') as f:
        table = json.load(f)['codes']
    os.makedirs(args.out, exist_ok=True)
    manifest = {}
    for fam in FAMILIES:
        files = {}
        for style in STYLES:
            path, n = build(os.path.join(args.tinos, 'Tinos-%s.ttf' % style), fam, style, table, args.out)
            files[style] = os.path.basename(path)
            print('%-24s %6d B  %d remapped codes' % (os.path.basename(path), os.path.getsize(path), n))
        manifest[FAMILIES[fam]] = files
    with open(os.path.join(args.out, 'vn-fonts.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'basedOn': 'Tinos', 'fonts': manifest}, f, indent=1)
        f.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
