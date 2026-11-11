// Fonts installed on the user's computer, for exact text layout and PDF output.
//
// The editor (sdkjs) draws text itself from font files and the pack has no Arial, Calibri, Segoe UI ... (see
// NOTICE.md): their names answer to metric-compatible substitutes. A host page that may read the fonts of the user's
// computer (the Local Font Access API, Chromium only, with permission) can hand the fonts a document uses to the
// viewer, and the document then keeps the layout it has in Word on that computer.
//
// Two parts:
//   - prepareLocalFonts(list)      sorts {family, style?, data} into families with the four styles and reads the licence flag
//   - installLocalFonts(win, fams) runs inside the editor frame while sdkjs/common/AllFonts.js is evaluated (hook at the
//                                  end of that file, added by tools/font-pack.cjs) and adds the families to the font
//                                  list the editor reads next, with the font data already in memory (no request)
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const STYLES = ['Regular', 'Italic', 'Bold', 'BoldItalic']; // order of the indices in an entry of __fonts_infos
export const LOCAL_PREFIX = 'local-font-';

const u32 = (dv, p) => dv.getUint32(p, false);

/** sfnt header facts: {cff, bold, italic, fsType} or null (no TrueType/OpenType font), {collection: true} for .ttc. */
export function fontInfo(u8) {
  if (u8.length < 12) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = u32(dv, 0);
  if (tag === 0x74746366) return { collection: true };
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const n = dv.getUint16(4, false);
  const at = {};
  for (let i = 0; i < n; i++) {
    const p = 12 + 16 * i;
    if (p + 16 > u8.length) return null;
    at[u32(dv, p)] = u32(dv, p + 8);
  }
  const [OS2, HEAD, HHEA, POST, CMAP] = [0x4f532f32, 0x68656164, 0x68686561, 0x706f7374, 0x636d6170];
  const has = (t, len) => t in at && at[t] + len <= u8.length;
  const mac = has(HEAD, 46) ? dv.getUint16(at[HEAD] + 44, false) : 0;
  const info = {
    cff: tag === 0x4f54544f,
    bold: !!(mac & 1),
    italic: !!(mac & 2),
    fsType: 0,
    fixed: has(POST, 16) && dv.getUint32(at[POST] + 12, false) !== 0,
    cmap: has(CMAP, 4) ? at[CMAP] : -1,
    os2: null,
    hhea: has(HHEA, 10) ? { ascent: dv.getInt16(at[HHEA] + 4, false), descent: dv.getInt16(at[HHEA] + 6, false), lineGap: dv.getInt16(at[HHEA] + 8, false) } : null,
  };
  if (has(OS2, 78)) {
    const o = at[OS2];
    const version = dv.getUint16(o, false);
    info.fsType = dv.getUint16(o + 8, false);
    info.os2 = {
      avgCharWidth: dv.getInt16(o + 2, false), weight: dv.getUint16(o + 4, false), width: dv.getUint16(o + 6, false), familyClass: dv.getUint16(o + 30, false),
      panose: u8.subarray(o + 32, o + 42), unicode: [42, 46, 50, 54].map((k) => dv.getUint32(o + k, false)),
      codePage: version >= 1 && has(OS2, 86) ? [78, 82].map((k) => dv.getUint32(o + k, false)) : [0, 0],
      xHeight: version >= 2 && has(OS2, 90) ? dv.getInt16(o + 86, false) : 0, capHeight: version >= 2 && has(OS2, 90) ? dv.getInt16(o + 88, false) : 0,
    };
  }
  return info;
}

/** Whether the font has glyphs for all of `codePoints` (cmap formats 4 and 12; false when unsure). */
export function coversAll(u8, info, codePoints) {
  if (!info || info.cmap < 0) return false;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const base = info.cmap;
  const count = dv.getUint16(base + 2, false);
  const tables = [];
  for (let i = 0; i < count; i++) {
    const p = base + 4 + 8 * i;
    if (p + 8 > u8.length) break;
    const plat = dv.getUint16(p, false);
    const enc = dv.getUint16(p + 2, false);
    if ((plat === 3 && (enc === 1 || enc === 10)) || plat === 0) tables.push(base + dv.getUint32(p + 4, false));
  }
  const inTable = (t, cp) => {
    const fmt = dv.getUint16(t, false);
    if (fmt === 4) {
      const segX2 = dv.getUint16(t + 6, false);
      const ends = t + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const offsets = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        if (cp > dv.getUint16(ends + s, false)) continue;
        if (cp < dv.getUint16(starts + s, false)) return false;
        const off = dv.getUint16(offsets + s, false);
        if (off === 0) return ((cp + dv.getInt16(deltas + s, false)) & 0xffff) !== 0;
        const gp = offsets + s + off + 2 * (cp - dv.getUint16(starts + s, false));
        return gp + 2 <= u8.length && dv.getUint16(gp, false) !== 0;
      }
      return false;
    }
    if (fmt === 12) {
      const groups = dv.getUint32(t + 12, false);
      for (let g = 0; g < groups; g++) {
        const p = t + 16 + 12 * g;
        if (cp >= dv.getUint32(p, false) && cp <= dv.getUint32(p + 4, false)) return true;
      }
      return false;
    }
    return false;
  };
  return codePoints.every((cp) => tables.some((t) => t + 4 <= u8.length && inTable(t, cp)));
}

const VIETNAMESE = [...'ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ'].map((c) => c.codePointAt(0));

/** 'Regular' | 'Italic' | 'Bold' | 'BoldItalic' | null (Light, Semibold ... are other weights: not one of the four slots). */
export function slotOfStyle(style) {
  const s = String(style || '');
  if (/semi|demi|light|thin|black|heavy|medium|condensed|narrow|extra|ultra/i.test(s)) return null;
  const bold = /bold/i.test(s);
  const italic = /italic|oblique/i.test(s);
  return bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular';
}

/**
 * @param {{family: string, style?: string, data: Uint8Array|ArrayBuffer}[]} list
 * @param {{vietnamese?: boolean}} [need] vietnamese: the document has Vietnamese letters, so a font without them is not
 *   used: the editor cannot take the missing letters from another font, it would show boxes (the pack's substitute has them)
 * @returns {{families: {name: string, styles: Record<string, Uint8Array>, infos: Record<string, object>}[], embeddable: boolean[], skipped: string[]}}
 *   families[i].styles: font data per slot; embeddable[i]: false when a font of the family forbids embedding (OS/2 fsType
 *   "restricted licence": used for the display, kept out of the PDF); skipped: what could not be used and why
 */
export function prepareLocalFonts(list, need = {}) {
  const byName = new Map();
  const skipped = [];
  for (const item of list || []) {
    const name = String(item.family || '').trim();
    const data = item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data);
    const info = fontInfo(data);
    if (!name || !info) { skipped.push((name || '?') + ': not a font file'); continue; }
    if (info.collection) { skipped.push(name + ': font collection (.ttc) is not supported'); continue; }
    const slot = (item.style ? slotOfStyle(item.style) : info.bold ? (info.italic ? 'BoldItalic' : 'Bold') : info.italic ? 'Italic' : 'Regular');
    if (!slot) { skipped.push(name + ' ' + item.style + ': other weight'); continue; }
    const fam = byName.get(name.toLowerCase()) || { name, styles: {}, infos: {}, restricted: false };
    byName.set(name.toLowerCase(), fam);
    if (fam.styles[slot]) continue; // the first file of a style wins
    fam.styles[slot] = data;
    fam.infos[slot] = { ...info, vietnamese: coversAll(data, info, VIETNAMESE) };
    if (info.fsType & 0x0002) fam.restricted = true;
  }
  for (const [key, f] of byName) {
    if (need.vietnamese && Object.values(f.infos).some((i) => !i.vietnamese)) {
      skipped.push(f.name + ': lacks Vietnamese letters, the pack font stays');
      byName.delete(key);
    }
  }
  const families = [...byName.values()];
  return { families: families.map(({ name, styles, infos }) => ({ name, styles, infos })), embeddable: families.map((f) => !f.restricted), skipped };
}

// ---------- the font list of sdkjs (binary records, see fonts/font-aliases.cjs) ----------
const dec = new TextDecoder();
const enc = new TextEncoder();

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function readRecords(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getInt32(0, true);
  const records = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const len = dv.getInt32(pos, true);
    if (len < 12 || pos + len > buf.length) throw new Error('bad record length in g_fonts_selection_bin');
    let p = pos + 4;
    const str = () => {
      const n = dv.getInt32(p, true);
      const s = dec.decode(buf.subarray(p + 4, p + 4 + n));
      p += 4 + n;
      return s;
    };
    const name = str();
    const k = dv.getInt32(p, true);
    p += 4;
    const names = [];
    for (let j = 0; j < k; j++) names.push(str());
    records.push({ name, names, rest: buf.subarray(p, pos + len) });
    pos += len;
  }
  return { records, tail: buf.subarray(pos) };
}

function writeRecords({ records, tail }) {
  const parts = [];
  const int = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b; };
  const str = (s) => { const b = enc.encode(s); return [int(b.length), b]; };
  parts.push(int(records.length));
  for (const r of records) {
    const body = [...str(r.name), int(r.names.length), ...r.names.flatMap(str), r.rest];
    const size = body.reduce((a, b) => a + b.length, 0);
    parts.push(int(size + 4), ...body);
  }
  parts.push(tail);
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The record's `rest` starts with the font file path (int32 length + UTF-8): same record, other path. */
function withPath(rest, path) {
  const n = new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getInt32(0, true);
  const p = enc.encode(path);
  const out = new Uint8Array(4 + p.length + rest.length - 4 - n);
  new DataView(out.buffer).setInt32(0, p.length, true);
  out.set(p, 4);
  out.set(rest.subarray(4 + n), 4 + p.length);
  return out;
}

/** The record of a font file: a copy of `template` with the path and what the font file says about itself. */
function recordFor(template, path, info) {
  const rest = withPath(template, path);
  const p = 4 + enc.encode(path).length;
  const dv = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
  const set32 = (o, v) => dv.setUint32(p + o, v >>> 0, true);
  const set16 = (o, v) => dv.setUint16(p + o, v & 0xffff, true);
  set32(4, info.italic ? 1 : 0);
  set32(8, info.bold ? 1 : 0);
  set32(12, info.fixed ? 1 : 0);
  const o = info.os2;
  if (o) {
    for (let i = 0; i < 10; i++) rest[p + 20 + i] = o.panose[i];
    o.unicode.forEach((v, i) => set32(30 + 4 * i, v));
    o.codePage.forEach((v, i) => set32(46 + 4 * i, v));
    set16(54, o.weight); set16(56, o.width); set16(58, o.familyClass); set16(62, o.avgCharWidth);
    set16(70, o.xHeight); set16(72, o.capHeight); set16(74, info.fsType);
  }
  if (info.hhea) { set16(64, info.hhea.ascent); set16(66, info.hhea.descent); set16(68, info.hhea.lineGap); }
  // What sdkjs reads to decide that a letter needs another font: claim Vietnamese only for a font that has all its letters
  if (o) {
    const bits = (set, value, bit) => (set ? value | (1 << bit) : value & ~(1 << bit)) >>> 0;
    set32(30, bits(info.vietnamese, o.unicode[0], 29) /* bit 29 of range 1 = Latin Extended Additional */);
    set32(46, bits(info.vietnamese, o.codePage[0], 8) /* code page 1258 */);
  }
  return rest;
}

/**
 * Adds the families to the font list that sdkjs/common/AllFonts.js has just defined in `win` (the editor frame) and
 * makes the loaders of their files answer from memory. A family already in the list (a font of the pack) is left alone.
 * Document fonts then resolve to these files: the record is a copy of an Arimo record with the facts of the font file
 * (style, panose, unicode ranges - Vietnamese only when the font has all its letters -, metrics) and the names the pack answers to for them (aliases such as Arial -> Arimo)
 * are taken away from the other records.
 * @returns {string[]} names of the families installed
 */
export function installLocalFonts(win, families) {
  const files = win.__fonts_files;
  const infos = win.__fonts_infos;
  if (!Array.isArray(files) || !Array.isArray(infos) || typeof win.g_fonts_selection_bin !== 'string') throw new Error('no font list in the editor frame');
  const list = readRecords(b64decode(win.g_fonts_selection_bin));
  const template = list.records.find((r) => r.name === 'Arimo') || list.records[0];
  const known = new Set(infos.map((i) => i[0]));
  const data = new Map(); // file id -> bytes
  const installed = [];
  families.forEach((fam, n) => {
    if (known.has(fam.name)) return;
    const entry = [fam.name];
    for (const style of STYLES) {
      const bytes = fam.styles[style];
      if (!bytes) { entry.push(-1, -1); continue; }
      const id = LOCAL_PREFIX + n + '-' + style + '.ttf';
      entry.push(files.push(id) - 1, 0);
      data.set(id, bytes);
      list.records.push({ name: fam.name, names: [], rest: recordFor(template.rest, id, fam.infos[style]) });
    }
    infos.push(entry);
    known.add(fam.name);
    installed.push(fam.name);
    for (const r of list.records) if (r.name !== fam.name) r.names = r.names.filter((x) => x !== fam.name);
  });
  if (!installed.length) return installed;
  win.g_fonts_selection_bin = b64encode(writeRecords(list));
  // sdkjs builds its font loaders from __fonts_files when sdk-all.js starts and stores them in AscFonts.g_font_files:
  // watch that assignment and give the loaders of our files their data (Status 0 = loaded, no request)
  const AF = win.AscFonts || (win.AscFonts = {});
  let loaders;
  const prepare = (v) => {
    for (const l of v || []) {
      const bytes = data.get(l && l.Id);
      if (!bytes) continue;
      l.LoadFontAsync = function (basePath, callback) {
        if (this.Status !== -1) return true;
        this.LoadFontFromData(bytes.slice());
        if (callback) callback();
        if (this.externalCallback) this.externalCallback();
        return undefined;
      };
    }
  };
  Object.defineProperty(AF, 'g_font_files', {
    configurable: true,
    enumerable: true,
    get: () => loaders,
    set: (v) => { loaders = v; prepare(v); },
  });
  return installed;
}
