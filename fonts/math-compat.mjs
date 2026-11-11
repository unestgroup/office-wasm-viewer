// Substitute fonts for MathType equation pictures.
//
// MathType stores every equation as a WMF picture whose text records name the fonts "MT Extra", "Symbol" and the
// "Euclid" family. Those fonts cannot be shipped to a browser (licence), and without them the symbols come out as
// letters ("uuur" instead of a vector arrow). ./math/ holds open substitutes built from STIX Two Math (OFL 1.1),
// one per legacy encoding; see ./math-src/build-math-fonts.py. This module points the pictures at them:
//   - preview: x2t turns each WMF into an SVG that the editor shows through an <img>. An image cannot load fonts
//     from the page, so the font is embedded in the SVG itself (data: URI) and the font-family is rewritten.
//   - PDF: x2t draws the WMF/EMF itself and picks fonts by face name from its font directory, so the face names in
//     the META_CREATEFONTINDIRECT (WMF) / EMR_EXTCREATEFONTINDIRECTW (EMF) records are rewritten and the .ttf files
//     are added to that directory.

// legacy face name (lower case) -> key in math-fonts.json
const FACES = {
  'mt extra': 'extra',
  'euclid extra': 'extra',
  symbol: 'symbol',
  'euclid symbol': 'symbol',
  'euclid math two': 'blackboard',
  'euclid math one': 'script',
  'euclid fraktur': 'fraktur',
};

const META_CREATEFONTINDIRECT = 0x02fb;
const LOGFONT_FIXED = 18; // bytes of LOGFONT16 before the face name
const FACE_BYTES = 32;

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Rewrites the face names of the font records of a WMF picture.
 * @param {Uint8Array} data
 * @param {(face: string) => string|null|undefined} rename  new face name (at most 31 ASCII characters) or nothing to keep
 * @returns {Uint8Array|null} the new file, or null when nothing changed or the data is not a WMF
 */
export function renameWmfFonts(data, rename) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 40) return null;
  const start = dv.getUint32(0, true) === 0x9ac6cdd7 ? 22 : 0; // placeable header
  const type = dv.getUint16(start, true);
  const headerBytes = dv.getUint16(start + 2, true) * 2;
  if ((type !== 1 && type !== 2) || headerBytes !== 18) return null;
  const parts = [];
  let last = 0;
  let total = 0;
  let maxRecord = dv.getUint32(start + 12, true);
  let p = start + headerBytes;
  while (p + 6 <= data.length) {
    const size = dv.getUint32(p, true) * 2;
    const fn = dv.getUint16(p + 4, true);
    if (size < 6 || p + size > data.length) break;
    if (fn === META_CREATEFONTINDIRECT && size >= 6 + LOGFONT_FIXED + 1) {
      const a = p + 6 + LOGFONT_FIXED;
      let face = '';
      for (let i = a; i < p + size && i < a + FACE_BYTES && data[i]; i++) face += String.fromCharCode(data[i]);
      const to = rename(face);
      if (to && to !== face && to.length < FACE_BYTES && /^[\x20-\x7e]+$/.test(to)) {
        const rec = new Uint8Array(6 + LOGFONT_FIXED + FACE_BYTES);
        rec.set(data.subarray(p, a));
        for (let i = 0; i < to.length; i++) rec[6 + LOGFONT_FIXED + i] = to.charCodeAt(i);
        new DataView(rec.buffer).setUint32(0, rec.length / 2, true);
        const before = data.subarray(last, p);
        parts.push(before, rec);
        total += before.length + rec.length;
        last = p + size;
        maxRecord = Math.max(maxRecord, rec.length / 2);
      }
    }
    p += size;
    if (fn === 0) break; // META_EOF
  }
  if (!parts.length) return null;
  const rest = data.subarray(last);
  const out = new Uint8Array(total + rest.length);
  let o = 0;
  for (const part of [...parts, rest]) {
    out.set(part, o);
    o += part.length;
  }
  const odv = new DataView(out.buffer);
  odv.setUint32(start + 6, (out.length - start) / 2, true); // file size in words, without the placeable header
  odv.setUint32(start + 12, maxRecord, true);
  return out;
}

const EMR_EXTCREATEFONTINDIRECTW = 0x52;
const EMF_FACE_AT = 8 + 4 + 28; // record header, ihFont, the fixed fields of LOGFONTW before lfFaceName
const EMF_FACE_CHARS = 32;

const EMR_COMMENT = 70;
const EMFPLUS_ID = 0x2b464d45; // "EMF+" little endian: the data of a comment record that carries GDI+ records
const EMFPLUS_OBJECT = 0x4008;
const EMFPLUS_OBJECT_FONT = 6; // ObjectType: 1 brush, 2 pen, 3 path, 4 region, 5 image, 6 font, 7 string format
const EMFPLUS_FONT_NAME_AT = 24; // version, emSize, unit, style, reserved, length (6 x 4 bytes), then UTF-16 family name

function isEmf(dv, length) {
  return length >= 88 && dv.getUint32(0, true) === 1 && dv.getUint32(40, true) === 0x464d4520; // EMR_HEADER, " EMF"
}

/**
 * EMF+ (GDI+): the family names are in EmfPlusObject records of type Font, which sit in EMR_COMMENT records that start
 * with "EMF+". A new name has another length than the old one, so the records, the comment and the EMF header
 * (byte count) are rebuilt.
 * @returns {Uint8Array|null} null when nothing changed
 */
function renameEmfPlusFonts(data, rename) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts = [];
  let changed = false;
  let p = 0;
  while (p + 8 <= data.length) {
    const type = dv.getUint32(p, true);
    const size = dv.getUint32(p + 4, true);
    if (size < 8 || size % 4 || p + size > data.length) break;
    let rec = data.subarray(p, p + size);
    if (type === EMR_COMMENT && size >= 20 && dv.getUint32(p + 12, true) === EMFPLUS_ID) {
      const inner = [];
      let innerChanged = false;
      const end = Math.min(p + 12 + dv.getUint32(p + 8, true), p + size);
      let q = p + 16;
      while (q + 12 <= end) {
        const rtype = dv.getUint16(q, true);
        const flags = dv.getUint16(q + 2, true);
        const rsize = dv.getUint32(q + 4, true);
        if (rsize < 12 || q + rsize > end) break;
        let piece = data.subarray(q, q + rsize);
        const dataSize = dv.getUint32(q + 8, true);
        if (rtype === EMFPLUS_OBJECT && ((flags >> 8) & 0x7f) === EMFPLUS_OBJECT_FONT && dataSize >= EMFPLUS_FONT_NAME_AT && 12 + dataSize <= rsize) {
          const n = dv.getUint32(q + 12 + 20, true);
          if (n > 0 && n < 256 && EMFPLUS_FONT_NAME_AT + n * 2 <= dataSize) {
            let face = '';
            for (let i = 0; i < n; i++) face += String.fromCharCode(dv.getUint16(q + 12 + EMFPLUS_FONT_NAME_AT + i * 2, true));
            const to = rename(face);
            if (to && to !== face && /^[ -~]+$/.test(to)) {
              const bodyLen = EMFPLUS_FONT_NAME_AT + to.length * 2;
              const padded = bodyLen + (-bodyLen & 3);
              piece = new Uint8Array(12 + padded);
              piece.set(data.subarray(q, q + 12 + EMFPLUS_FONT_NAME_AT));
              const pdv = new DataView(piece.buffer);
              pdv.setUint32(4, piece.length, true);
              pdv.setUint32(8, padded, true);
              pdv.setUint32(12 + 20, to.length, true);
              for (let i = 0; i < to.length; i++) pdv.setUint16(12 + EMFPLUS_FONT_NAME_AT + i * 2, to.charCodeAt(i), true);
              innerChanged = true;
            }
          }
        }
        inner.push(piece);
        q += rsize;
      }
      if (innerChanged) {
        inner.push(data.subarray(q, p + size)); // whatever follows the last EMF+ record
        const body = inner.reduce((a, b) => a + b.length, 0); // after the 16 bytes: type, size, data size, "EMF+"
        rec = new Uint8Array(16 + body);
        const rdv = new DataView(rec.buffer);
        rec.set(data.subarray(p, p + 16));
        let at = 16;
        for (const b of inner) { rec.set(b, at); at += b.length; }
        rdv.setUint32(4, rec.length, true);
        rdv.setUint32(8, rec.length - 12, true);
        changed = true;
      }
    }
    parts.push(rec);
    p += size;
    if (type === 14) break; // EMR_EOF
  }
  if (!changed) return null;
  parts.push(data.subarray(p));
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  new DataView(out.buffer).setUint32(48, out.length, true); // EMR_HEADER nBytes
  return out;
}

/**
 * Rewrites the face names of the font records of an EMF picture: GDI records (EMR_EXTCREATEFONTINDIRECTW; the new
 * name is written over the old one inside the record, a LOGFONTW has a fixed 32-character name field, so no size
 * changes) and GDI+ records (EMF+ font objects, see renameEmfPlusFonts).
 * @param {Uint8Array} data
 * @param {(face: string) => string|null|undefined} rename  new face name (printable ASCII; at most 31 characters
 *   for the GDI records) or nothing to keep
 * @returns {Uint8Array|null} the new file, or null when nothing changed or the data is not an EMF
 */
export function renameEmfFonts(data, rename) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (!isEmf(dv, data.length)) return null;
  let out = null;
  let p = 0;
  while (p + 8 <= data.length) {
    const type = dv.getUint32(p, true);
    const size = dv.getUint32(p + 4, true);
    if (size < 8 || size % 4 || p + size > data.length) break;
    if (type === EMR_EXTCREATEFONTINDIRECTW && size >= EMF_FACE_AT + EMF_FACE_CHARS * 2) {
      let face = '';
      for (let i = 0; i < EMF_FACE_CHARS; i++) {
        const c = dv.getUint16(p + EMF_FACE_AT + i * 2, true);
        if (!c) break;
        face += String.fromCharCode(c);
      }
      const to = rename(face);
      if (to && to !== face && to.length < EMF_FACE_CHARS && /^[ -~]+$/.test(to)) {
        out ??= new Uint8Array(data);
        const odv = new DataView(out.buffer);
        for (let i = 0; i < EMF_FACE_CHARS; i++) odv.setUint16(p + EMF_FACE_AT + i * 2, i < to.length ? to.charCodeAt(i) : 0, true);
      }
    }
    p += size;
    if (type === 14) break; // EMR_EOF
  }
  return renameEmfPlusFonts(out ?? data, rename) ?? out;
}

export class MathFonts {
  /**
   * @param {string|URL} base  URL of the directory with math-fonts.json and the font files (./math/)
   * @param {{preferInstalled?: boolean}} [opts]  preferInstalled: in the preview, use the reader's own "MT Extra" /
   *   "Symbol" when the system has them and the substitute only as a fallback. The default is the substitute first,
   *   which looks the same on every system. (The PDF always uses the substitutes: x2t sees no system fonts.)
   */
  constructor(base, opts = {}) {
    this.base = String(base);
    this.preferInstalled = !!opts.preferInstalled;
    this.manifest = null;
    this.dataUris = new Map();
    this.loading = null;
  }

  /** Reads the manifest. Safe to call more than once. */
  load() {
    this.loading ??= fetch(this.base + 'math-fonts.json').then(async (r) => {
      if (!r.ok) throw new Error('math fonts manifest: HTTP ' + r.status);
      this.manifest = await r.json();
    });
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  }

  #font(face) {
    const key = FACES[String(face).trim().toLowerCase()];
    return key && this.manifest ? { key, ...this.manifest.fonts[key] } : null;
  }

  /** Font files to add to the x2t font directory (PDF). */
  ttfFiles() {
    return Object.values(this.manifest.fonts).map((f) => f.ttf);
  }

  async #dataUri(font) {
    if (!this.dataUris.has(font.key)) {
      this.dataUris.set(font.key, fetch(this.base + font.woff2).then(async (r) => {
        if (!r.ok) throw new Error('math font ' + font.woff2 + ': HTTP ' + r.status);
        return 'data:font/woff2;base64,' + base64(new Uint8Array(await r.arrayBuffer()));
      }));
    }
    return this.dataUris.get(font.key);
  }

  /**
   * Preview: SVG written by x2t -> the same SVG using the substitute fonts, embedded.
   * @param {Uint8Array} data
   * @returns {Promise<Uint8Array|null>} null when the picture uses none of the legacy fonts
   */
  async svg(data) {
    await this.load();
    const used = new Map();
    const text = new TextDecoder().decode(data);
    const out = text.replace(/font-family="([^"]*)"/g, (all, face) => {
      const font = this.#font(face);
      if (!font) return all;
      used.set(font.key, font);
      return 'font-family="' + (this.preferInstalled ? face + ', ' + font.family : font.family + ', ' + face) + '"';
    });
    if (!used.size) return null;
    let css = '';
    for (const font of used.values()) {
      css += `@font-face{font-family:"${font.family}";src:url(${await this.#dataUri(font)}) format("woff2")}`;
    }
    const at = out.search(/<svg\b[^>]*>/);
    if (at < 0) return null;
    const end = out.indexOf('>', at) + 1;
    return new TextEncoder().encode(out.slice(0, end) + '<style>' + css + '</style>' + out.slice(end));
  }

  /**
   * PDF: WMF picture -> the same picture naming the substitute fonts. Needs load() to have finished.
   * @param {Uint8Array} data
   * @returns {Uint8Array|null} null when the picture uses none of the legacy fonts
   */
  wmf(data) {
    return renameWmfFonts(data, (face) => this.#font(face)?.family);
  }

  /**
   * PDF: EMF picture -> the same picture naming the substitute fonts. Needs load() to have finished.
   * @param {Uint8Array} data
   * @returns {Uint8Array|null} null when the picture uses none of the legacy fonts
   */
  emf(data) {
    return renameEmfFonts(data, (face) => this.#font(face)?.family);
  }
}
