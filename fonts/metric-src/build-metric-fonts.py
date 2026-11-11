#!/usr/bin/env python3
"""Builds fonts/metric/: open fonts with the metrics of common Word fonts (or the closest ones available).

Inputs are downloaded files, listed with URLs and checksums in ../metric/SOURCE.md; the script takes the directory
that holds them (see SOURCES below for the layout). Outputs go to <out>/ together with metric-fonts.json, which
tools/font-pack.cjs reads.

  Word font          -> pack family          how
  Georgia            -> Gelasio              OFL, designed to match Georgia; variable font -> four static instances
  Garamond           -> EB Garamond          OFL, a Garamond revival (about 5% wider than Monotype Garamond); same
  Palatino Linotype, -> WasmPagella          TeX Gyre Pagella (GUST font licence), OTF (CFF) -> TrueType, renamed
  Book Antiqua
  Century Gothic     -> WasmAdventor         TeX Gyre Adventor (same licence; Century Gothic follows Avant Garde metrics)
  Segoe UI           -> WasmUI (+Light, +Semibold)   Selawik (Microsoft, OFL, metric-compatible with Segoe UI), renamed
                                             (Reserved Font Name), Vietnamese letters added from Roboto; no italic
  Arial Narrow       -> WasmNarrow           Liberation Sans Narrow 1.07.4 (metric-compatible), renamed, Vietnamese from Arimo
  Comic Sans MS      -> WasmComic            Comic Relief (OFL, metric-compatible), renamed, Vietnamese from Arimo; no italic
  Cambria            -> WasmCaladea          Caladea (metric-compatible with Cambria) from the pack, renamed, Vietnamese from Tinos
  Tahoma, Verdana    -> WasmTahoma, WasmVerdana   Roboto / DejaVu Sans of the pack (closest with all Vietnamese letters), renamed,
                                             vertical metrics of the Word font

Every family also gets the vertical metrics (ascent/descent) of the Word font it stands for, so a line is as high as in
Word on Windows whichever of hhea / typo / win metrics the renderer reads (VERTICAL below: units per 2048 em, facts
measured on the Windows fonts, no font data). Glyphs added from a donor font keep the advance width of their base letter.

Usage (fontTools needed): python -I build-metric-fonts.py <download dir> <out dir> [<font pack dir>]
  <font pack dir> defaults to artifacts/onlyoffice-editor/fonts/fonts (donors Roboto, Arimo, Tinos, Caladea, DejaVu Sans).
"""
import hashlib
import json
import os
import shutil
import sys
import unicodedata

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.varLib import instancer

# Vietnamese letters (precomposed) a font needs for a Vietnamese document
VN_CHARS = 'ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ'

ALL4 = ('Regular', 'Bold', 'Italic', 'BoldItalic')
# Word on Windows: line height = usWinAscent + usWinDescent of the font (units per 2048 em)
VERTICAL = {
    'Georgia': {s: (1878, 449) for s in ALL4},
    'Garamond': {s: (1765, 539) for s in ALL4},
    'Palatino Linotype': {s: (2150, 613) for s in ALL4},
    'Century Gothic': {'Regular': (1989, 451), 'Bold': (2032, 451), 'Italic': (1989, 451), 'BoldItalic': (2060, 451)},
    'Segoe UI': {s: (2210, 514) for s in ALL4},
    'Arial Narrow': {'Regular': (1888, 431), 'Bold': (1910, 431), 'Italic': (1873, 431), 'BoldItalic': (1916, 434)},
    'Comic Sans MS': {s: (2257, 597) for s in ALL4},
    'Cambria': {s: (1946, 455) for s in ALL4},
    'Tahoma': {s: (2049, 423) for s in ALL4},
    'Verdana': {s: (2059, 430) for s in ALL4},
}

STYLE_FILE = {'Regular': 'Regular', 'Italic': 'Italic', 'Bold': 'Bold', 'BoldItalic': 'BoldItalic'}


def set_names(font, family, style):
    """Plain four-style naming: family + Regular/Bold/Italic/Bold Italic."""
    sub = {'Regular': 'Regular', 'Italic': 'Italic', 'Bold': 'Bold', 'BoldItalic': 'Bold Italic'}[style]
    full = family + ('' if style == 'Regular' else ' ' + sub)
    ps = family.replace(' ', '') + '-' + style
    name = font['name']
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    for nid, val in ((1, family), (2, sub), (3, ps + ';wasm'), (4, full), (6, ps)):
        name.setName(val, nid, 3, 1, 0x409)
        name.setName(val, nid, 1, 0, 0)
    os2 = font['OS/2']
    bold, italic = style in ('Bold', 'BoldItalic'), style in ('Italic', 'BoldItalic')
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0x20 if bold else 0) | (0x01 if italic else 0) | (0x40 if style == 'Regular' else 0)
    os2.usWeightClass = 700 if bold else 400
    font['head'].macStyle = (1 if bold else 0) | (2 if italic else 0)


def drop_variations(font):
    for t in ('STAT', 'avar', 'fvar', 'gvar', 'HVAR', 'MVAR', 'cvar'):
        if t in font:
            del font[t]


def instance(src, wght, family, style, out, vertical=None):
    f = TTFont(src)
    f = instancer.instantiateVariableFont(f, {'wght': wght}, inplace=False)
    drop_variations(f)
    if vertical:
        set_vertical(f, *vertical)
    set_names(f, family, style)
    f.save(out)


def otf_to_ttf(src, family, style, out, vertical=None):
    """CFF outlines -> quadratic TrueType outlines (max error 1 unit per 1000)."""
    font = TTFont(src)
    order = font.getGlyphOrder()
    gs = font.getGlyphSet()
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(gs)
        gs[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
        glyphs[name] = pen.glyph()
    font['loca'] = newTable('loca')
    glyf = font['glyf'] = newTable('glyf')
    glyf.glyphOrder = order
    glyf.glyphs = glyphs
    del font['CFF ']
    if 'VORG' in font:
        del font['VORG']
    font['head'].glyphDataFormat = 0
    maxp = font['maxp'] = newTable('maxp')
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    maxp.maxTwilightPoints = maxp.maxStorage = maxp.maxFunctionDefs = maxp.maxInstructionDefs = 0
    maxp.maxStackElements = maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = max(len(g.components if hasattr(g, 'components') else []) for g in glyphs.values())
    maxp.numGlyphs = len(order)
    post = font['post']
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = order
    font.sfntVersion = '\x00\x01\x00\x00'
    for g in glyphs.values():
        g.recalcBounds(glyf)
    maxp.recalc(font)
    if vertical:
        set_vertical(font, *vertical)
    set_names(font, family, style)
    font.save(out)


def set_vertical(font, asc2048, desc2048):
    """The same ascent/descent in hhea, OS/2 typo and OS/2 win, no line gap: the same line height whichever the renderer reads."""
    upm = font['head'].unitsPerEm
    asc, desc = round(asc2048 * upm / 2048), round(desc2048 * upm / 2048)
    hhea, os2 = font['hhea'], font['OS/2']
    hhea.ascent, hhea.descent, hhea.lineGap = asc, -desc, 0
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = asc, -desc, 0
    os2.usWinAscent, os2.usWinDescent = asc, desc


def _height(font, ch):
    gs = font.getGlyphSet()
    pen = BoundsPen(gs)
    gs[font.getBestCmap()[ord(ch)]].draw(pen)
    return pen.bounds[3]


def add_vietnamese(font, donor):
    """Adds the Vietnamese letters the font lacks from `donor`: outline scaled to the x-height / cap height of `font` and
    stretched to the advance width of the base letter (so text is as wide as with the Word font), glyph names uniXXXX."""
    cmap, dcmap = font.getBestCmap(), donor.getBestCmap()
    upm, dupm = font['head'].unitsPerEm, donor['head'].unitsPerEm
    xh, cap = _height(font, 'x') / upm, _height(font, 'H') / upm
    dxh, dcap = _height(donor, 'x') / dupm, _height(donor, 'H') / dupm
    dgs = donor.getGlyphSet()
    glyf, hmtx = font['glyf'], font['hmtx']
    order = list(font.getGlyphOrder())
    added = 0
    for ch in VN_CHARS:
        cp = ord(ch)
        if cp in cmap or cp not in dcmap:
            continue
        base = {'đ': 'd', 'Đ': 'D'}.get(ch) or unicodedata.normalize('NFD', ch)[0]
        if ord(base) not in cmap or ord(base) not in dcmap:
            continue
        tadv = hmtx[cmap[ord(base)]][0] / upm
        dadv = donor['hmtx'][dcmap[ord(base)]][0] / dupm
        sy = (cap / dcap if ch.isupper() else xh / dxh) * upm / dupm
        sx = tadv / dadv * upm / dupm
        rec = DecomposingRecordingPen(dgs)
        dgs[dcmap[cp]].draw(rec)
        pen = TTGlyphPen(None)
        rec.replay(TransformPen(pen, (sx, 0, 0, sy, 0, 0)))
        glyph = pen.glyph()
        glyph.recalcBounds(glyf)
        name = 'uni%04X' % cp
        glyf.glyphs[name] = glyph
        order.append(name)
        hmtx.metrics[name] = (round(tadv * upm), glyph.xMin if glyph.numberOfContours else 0)
        for t in font['cmap'].tables:
            if t.isUnicode() and cp < 0x10000 and t.format in (4, 6, 12):
                t.cmap[cp] = name
        added += 1
    font.setGlyphOrder(order)
    glyf.glyphOrder = order
    for t in ('hdmx', 'LTSH', 'VDMX'):
        if t in font:
            del font[t]
    os2 = font['OS/2']
    os2.ulUnicodeRange1 |= 1 << 29  # Latin Extended Additional
    os2.ulCodePageRange1 |= 1 << 8  # 1258 Vietnamese
    missing = [c for c in VN_CHARS if ord(c) not in font.getBestCmap()]
    assert not missing, 'still missing: ' + ''.join(missing)
    return added


def derive(src, family, style, out, donor=None, vertical=None):
    """A copy of `src` under the name `family`, with Vietnamese letters from `donor` and the vertical metrics of the Word font."""
    f = TTFont(src)
    if donor:
        add_vietnamese(f, TTFont(donor))
    if vertical:
        set_vertical(f, *vertical)
    set_names(f, family, style)
    f.save(out)


def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def main():
    src, out = sys.argv[1:3]
    pack = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'artifacts', 'onlyoffice-editor', 'fonts', 'fonts')
    os.makedirs(out, exist_ok=True)
    j = lambda *p: os.path.join(src, *p)
    families = {}

    def record(name, styles, files_from, aliases, clone, note):
        families[name] = {'files': styles, 'aliases': aliases, 'cloneFrom': clone, 'note': note, 'sources': files_from}

    # --- instanced from variable fonts ---
    for fam, upright, italic, aliases, clone, note, word in (
        ('Gelasio', j('gelasio', 'Gelasio[wght].ttf'), j('gelasio', 'Gelasio-Italic[wght].ttf'), ['Georgia'], 'Tinos', 'metric-compatible with Georgia', 'Georgia'),
        ('EB Garamond', j('ebg', 'EBGaramond[wght].ttf'), j('ebg', 'EBGaramond-Italic[wght].ttf'), ['Garamond'], 'Tinos', 'Garamond revival, about 5% wider than Monotype Garamond', 'Garamond'),
    ):
        stem = fam.replace(' ', '')
        files = {}
        for style, path, w in (('Regular', upright, 400), ('Bold', upright, 700), ('Italic', italic, 400), ('BoldItalic', italic, 700)):
            fn = '%s-%s.ttf' % (stem, style)
            instance(path, w, fam, style, os.path.join(out, fn), VERTICAL[word][style])
            files[style] = fn
        record(fam, files, [os.path.relpath(upright, src), os.path.relpath(italic, src)], aliases, clone, note)

    # --- OTF -> TTF, renamed (GUST licence asks derived works to carry other names) ---
    for fam, stem, aliases, clone, note, word in (
        ('WasmPagella', 'texgyrepagella', ['Palatino Linotype', 'Book Antiqua'], 'Tinos', 'TeX Gyre Pagella (Palatino metrics)', 'Palatino Linotype'),
        ('WasmAdventor', 'texgyreadventor', ['Century Gothic'], 'Arimo', 'TeX Gyre Adventor (Avant Garde metrics, as Century Gothic)', 'Century Gothic'),
    ):
        files = {}
        for style, suffix in (('Regular', 'regular'), ('Bold', 'bold'), ('Italic', 'italic'), ('BoldItalic', 'bolditalic')):
            fn = '%s-%s.ttf' % (fam, style)
            otf_to_ttf(j('gyre', '%s-%s.otf' % (stem, suffix)), fam, style, os.path.join(out, fn), VERTICAL[word][style])
            files[style] = fn
        record(fam, files, ['gyre/%s-*.otf' % stem], aliases, clone, note)

    # --- renamed copies: Vietnamese letters from a donor of the pack (when the font lacks them), vertical metrics of the Word font ---
    P = lambda f: os.path.join(pack, f)
    # family, {style: (source file, donor file or None)}, sources, aliases, cloneFrom, note, Word font
    for fam, styles, sources, aliases, clone, note, word in (
        ('WasmUI', {'Regular': (j('selawik/x/selawk.ttf'.replace('/', os.sep)), P('Roboto-Regular.ttf')), 'Bold': (j('selawik/x/selawkb.ttf'.replace('/', os.sep)), P('Roboto-Bold.ttf'))},
         ['selawik/s.zip', 'pack:Roboto'], ['Segoe UI'], 'Arimo', 'Selawik (metric-compatible with Segoe UI) + Vietnamese letters from Roboto; no italic', 'Segoe UI'),
        ('WasmUI Light', {'Regular': (j('selawik/x/selawkl.ttf'.replace('/', os.sep)), P('Roboto-Light.ttf'))},
         ['selawik/s.zip', 'pack:Roboto'], ['Segoe UI Light'], 'Arimo', 'Selawik Light + Vietnamese letters from Roboto Light', 'Segoe UI'),
        ('WasmUI Semibold', {'Regular': (j('selawik/x/selawksb.ttf'.replace('/', os.sep)), P('Roboto-Bold.ttf'))},
         ['selawik/s.zip', 'pack:Roboto'], ['Segoe UI Semibold'], 'Arimo', 'Selawik Semibold + Vietnamese letters from Roboto Bold', 'Segoe UI'),
        ('WasmNarrow', {s: (j('deb107b', 'LiberationSansNarrow-%s.ttf' % s), P('Arimo-%s.ttf' % s)) for s in ALL4},
         ['deb107b/fonts-liberation_1.07.4-11_all.deb', 'pack:Arimo'], ['Arial Narrow'], 'Arimo', 'Liberation Sans Narrow 1.07.4 (metric-compatible with Arial Narrow) + Vietnamese letters from Arimo', 'Arial Narrow'),
        ('WasmComic', {s: (j('comic', 'ComicRelief-%s.ttf' % s), P('Arimo-%s.ttf' % s)) for s in ('Regular', 'Bold')},
         ['comic/ComicRelief-*.ttf', 'pack:Arimo'], ['Comic Sans MS'], 'Arimo', 'Comic Relief (metric-compatible with Comic Sans MS) + Vietnamese letters from Arimo; no italic', 'Comic Sans MS'),
        ('WasmCaladea', {s: (P('Caladea-%s.ttf' % s), P('Tinos-%s.ttf' % s)) for s in ALL4},
         ['pack:Caladea', 'pack:Tinos'], ['Cambria', 'Cambria Math'], 'Caladea', 'Caladea (metric-compatible with Cambria) + Vietnamese letters from Tinos', 'Cambria'),
        ('WasmTahoma', {s: (P('Roboto-%s.ttf' % s), None) for s in ALL4},
         ['pack:Roboto'], ['Tahoma'], 'Roboto', 'Roboto with the line height of Tahoma (closest font with all Vietnamese letters)', 'Tahoma'),
        ('WasmVerdana', {s: (P(f), None) for s, f in (('Regular', 'DejaVuSans.ttf'), ('Bold', 'DejaVuSans-Bold.ttf'))},
         ['pack:DejaVu Sans'], ['Verdana'], 'DejaVu Sans', 'DejaVu Sans with the line height of Verdana (closest font with all Vietnamese letters)', 'Verdana'),
    ):
        files = {}
        for style, (path, donor) in styles.items():
            fn = '%s-%s.ttf' % (fam.replace(' ', ''), style)
            derive(path, fam, style, os.path.join(out, fn), donor, VERTICAL[word][style])
            files[style] = fn
        record(fam, files, sources, aliases, clone, note)

    for name, d in (('OFL-Gelasio.txt', 'gelasio/OFL.txt'), ('OFL-EBGaramond.txt', 'ebg/OFL.txt'), ('OFL-ComicRelief.txt', 'comic/OFL.txt'),
                    ('OFL-Selawik.txt', 'selawik/LICENSE.txt'), ('GUST-FONT-LICENSE.txt', 'gyre/GUST-FONT-LICENSE.txt'), ('Liberation-copyright.txt', 'deb107b/copyright')):
        shutil.copy(j(*d.split('/')), os.path.join(out, name))
    for f in families.values():
        f['sha256'] = {s: sha(os.path.join(out, fn)) for s, fn in f['files'].items()}
    json.dump({'fonts': families}, open(os.path.join(out, 'metric-fonts.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print('built', ', '.join(families))


main()
