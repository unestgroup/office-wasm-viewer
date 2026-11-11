# Substitute fonts for MathType equations

MathType saves each equation as a WMF picture whose text records use legacy 8-bit fonts. These fonts reproduce their
encodings with glyphs of STIX Two Math (SIL OFL 1.1, see `OFL.txt`), so the pictures draw correctly without the
original fonts, which may not be redistributed.

| File | Replaces | Encoding |
|---|---|---|
| `WasmMathExtra.*` | MT Extra, Euclid Extra | MT Extra (arrows, harpoons, over/under braces, ℝ 0xA1, ℕ 0xA5, wide hat 0xB5, ...) |
| `WasmMathSymbol.*` | Symbol, Euclid Symbol | Adobe Symbol (Greek, relations, bracket pieces, integral, ...) |
| `WasmMathBlackboard.*` | Euclid Math Two | double-struck A–Z and k, triangles, relations (≤ ≮ ⊊ ≺ ...), set operators |
| `WasmMathScript.*` | Euclid Math One | script capitals, circled/squared operators, slashes, turnstiles, arrows, harpoons, Hebrew letters, misc. |
| `WasmMathFraktur.*` | Euclid Fraktur | Fraktur letters A–Z a–z, digits and the ASCII punctuation of that font |

Each byte code C is reachable at the cp1252 character of C, at U+0080+C (Latin-1 reading) and at U+F000+C (symbol
font convention), because the SVG and PDF writers of x2t pass the byte through different decodings.
`math-fonts.json` lists the codes of each font. Glyph positions in the equations come from the WMF, so only the
glyph boxes matter; they follow the metrics of the original fonts.

Sources of the encodings: the official tables of Design Science (MathType character encodings), stored as data in
`../math-src/encodings/design-science.json` (byte code -> MathType code -> description). A MathType code is mapped to
the STIX glyph of the same character; codes of the MathType private use area are mapped to a Unicode character only
where the meaning is the same (list `PUA_ANALOG` in the build script). Codes without such a glyph are not drawn
(never replaced by another symbol); `math-fonts.json` lists them as `uncovered` (extenders and stretchy parts of
square brackets and loops, embellishments of two to four spaces, joint-status marks, arrows over small arrows,
`script 80/F6`, `extra E7`).

Covers WMF and EMF pictures (EMF: `renameEmfFonts` in `../math-compat.mjs`).
Rebuild: `npm run build:math-fonts` (see `../math-src/README.md`).
