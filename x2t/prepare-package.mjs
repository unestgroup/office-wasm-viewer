// Fixes in an OOXML package before it goes to x2t (preparePackage). The rest of the package is copied byte for byte
// (compressed data is not touched). When nothing needs fixing, or the package cannot be read (Zip64, encrypted, damaged),
// the input comes back unchanged.
//
// 1. EMZ / WMZ pictures (gzip-compressed EMF / WMF). x2t cannot read them: it does not recognise the format and aborts in
//    its image decoder ("missing function: heif_context_alloc"). The pictures are unpacked and stored as plain .emf / .wmf,
//    and the relationship files and [Content_Types].xml are pointed at the new names.
// 2. TCVN3 text: the letter u with horn is byte 0xAD in the Vietnamese legacy fonts (.VnTime, .VnTimeH), which is U+00AD
//    (soft hyphen) in the document. The editor never draws a soft hyphen. In runs that use those fonts it is rewritten to
//    U+F0AD, where the pack's versions of the fonts have the same glyph (fonts/vn-orig/patched, fonts/vn).
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const PICTURE = /^(.*)\.(emz|wmz)$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function stream(data, transform) {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(transform)).arrayBuffer());
}

/** Central directory entries: name, method, flags, crc, sizes and the position of the local header. */
function readEntries(zip, dv) {
  let eocd = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 22 - 65535); p--) {
    if (dv.getUint32(p, true) === SIG_EOCD) { eocd = p; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) return null; // Zip64
  const entries = [];
  const utf8 = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || dv.getUint32(p, true) !== SIG_CENTRAL) return null;
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const e = {
      flags: dv.getUint16(p + 8, true),
      method: dv.getUint16(p + 10, true),
      time: dv.getUint16(p + 12, true),
      date: dv.getUint16(p + 14, true),
      crc: dv.getUint32(p + 16, true),
      csize: dv.getUint32(p + 20, true),
      size: dv.getUint32(p + 24, true),
      local: dv.getUint32(p + 42, true),
      name: utf8.decode(zip.subarray(p + 46, p + 46 + nameLen)),
    };
    if (e.csize === 0xffffffff || e.size === 0xffffffff || e.local === 0xffffffff || e.flags & 1) return null; // Zip64, encrypted
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function compressedBytes(zip, dv, e) {
  const p = e.local;
  if (p + 30 > zip.length || dv.getUint32(p, true) !== SIG_LOCAL) throw new Error('bad local header');
  const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
  return zip.subarray(start, start + e.csize);
}

async function plainBytes(zip, dv, e) {
  const raw = compressedBytes(zip, dv, e);
  if (e.method === 0) return raw;
  if (e.method === 8) return stream(raw, new DecompressionStream('deflate-raw'));
  throw new Error('unsupported compression method ' + e.method);
}

const SHY = '­';
const SHY_ALIAS = '';
const VN_FONT = /\.Vn[A-Za-z]*/;
const TCVN_PARTS = /^(word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml|ppt\/(slides|notesSlides)\/[^/]+\.xml)$/;

const FONT_PARTS = /^(word\/(document|styles|numbering|fontTable|header\d*|footer\d*|footnotes|endnotes|comments|theme\/theme\d*)\.xml|ppt\/(slides|slideMasters|slideLayouts|notesSlides|theme)\/[^/]+\.xml|ppt\/presentation\.xml|xl\/styles\.xml|xl\/sharedStrings\.xml|xl\/theme\/theme\d*\.xml)$/;
const FONT_ATTR = /(?:w:(?:ascii|hAnsi|cs|eastAsia)|typeface)="([^"+][^"]*)"|<w:font w:name="([^"]+)"|<(?:x:)?name val="([^"]+)"/g;

// letters only Vietnamese needs (the others are in Latin-1): a font without them shows boxes
const VIETNAMESE_ONLY = /[ĂăĐđƠơƯưẠ-ỹ]/;

/** Names of the fonts a Word / PowerPoint / Excel file uses (run fonts, styles, theme, font table), in order of first use. */
export async function fontNamesOf(zip) {
  return (await scanDocument(zip)).fonts;
}

/** {fonts: names as fontNamesOf, vietnamese: the text has letters that need a font with Vietnamese support} */
export async function scanDocument(zip) {
  const found = new Set();
  let vietnamese = false;
  try {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const entries = readEntries(zip, dv);
    if (!entries) return [];
    const dec = new TextDecoder();
    for (const e of entries) {
      if (!FONT_PARTS.test(e.name)) continue;
      const xml = dec.decode(await plainBytes(zip, dv, e));
      if (!vietnamese && VIETNAMESE_ONLY.test(xml)) vietnamese = true;
      for (const m of xml.matchAll(FONT_ATTR)) {
        const n = (m[1] || m[2] || m[3]).trim();
        if (n && !n.startsWith('+') && n.length < 80) found.add(n);
      }
    }
  } catch { /* not a readable package: no names */ }
  return { fonts: [...found], vietnamese };
}

/** Ids of the styles of word/styles.xml whose fonts are .Vn*, and whether the document default is. */
function vnStyles(stylesXml) {
  const ids = new Set();
  const styleRe = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let defaultVn = /<w:docDefaults>[\s\S]*?<w:rFonts\b[^>]*\.Vn[^>]*>[\s\S]*?<\/w:docDefaults>/.test(stylesXml);
  for (let m; (m = styleRe.exec(stylesXml));) {
    if (!/<w:rFonts\b[^>]*\.Vn/.test(m[2])) continue;
    const id = /w:styleId="([^"]*)"/.exec(m[1]);
    if (id) ids.add(id[1]);
    if (/w:default="1"/.test(m[1]) && /w:type="paragraph"/.test(m[1])) defaultVn = true;
  }
  return { ids, defaultVn };
}

/** Rewrites U+00AD in the runs of one part that use a .Vn* font; returns the new text or null. */
function fixTcvnText(xml, name, styles, from = SHY, to = SHY_ALIAS) {
  if (!xml.includes(from)) return null;
  const swap = (run) => run.replace(/(<(?:w|a):t\b[^>]*>)([^<]*)/g, (all, open, text) => open + text.split(from).join(to));
  let out;
  if (name.startsWith('ppt/')) {
    out = xml.replace(/<a:r>[\s\S]*?<\/a:r>/g, (run) => (run.includes(from) && /<a:latin\b[^>]*typeface="[^"]*\.Vn/.test(run) ? swap(run) : run));
  } else {
    out = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (para) => {
      if (!para.includes(from)) return para;
      const pStyle = /<w:pStyle w:val="([^"]*)"/.exec(para);
      const paraVn = pStyle ? styles.ids.has(pStyle[1]) : styles.defaultVn;
      return para.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (run) => {
        if (!run.includes(from)) return run;
        const fonts = /<w:rFonts\b[^>]*>/.exec(run);
        let vn;
        if (fonts && /w:(ascii|hAnsi|cs|eastAsia)="/.test(fonts[0])) vn = VN_FONT.test(fonts[0]);
        else {
          const rStyle = /<w:rStyle w:val="([^"]*)"/.exec(run);
          vn = rStyle && styles.ids.has(rStyle[1]) ? true : paraVn;
        }
        return vn ? swap(run) : run;
      });
    });
  }
  return out === xml ? null : out;
}

/**
 * @param {Uint8Array} zip an OOXML package
 * @param {{restore?: boolean}} [options] restore: undo the TCVN3 rewrite (U+F0AD back to U+00AD, which is what Word and the
 *   real fonts expect) in a package the editor wrote; pictures are left alone then
 * @returns {Promise<{bytes: Uint8Array, converted: number, tcvnFixed: number}>} converted = pictures turned into EMF / WMF,
 *   tcvnFixed = parts in which U+00AD was rewritten
 */
export async function preparePackage(zip, { restore = false } = {}) {
  const same = { bytes: zip, converted: 0, tcvnFixed: 0 };
  try {
    if (zip.length < 22) return same;
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const entries = readEntries(zip, dv);
    if (!entries) return same;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const out = entries.map((e) => ({ e, name: e.name, data: null }));
    const byName = new Map(out.map((o) => [o.name, o]));

    // 1. EMZ / WMZ
    const renamed = new Map(); // old file name (last path segment) -> new one
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    for (const o of out) {
      const m = restore ? null : PICTURE.exec(o.name);
      if (!m) continue;
      const plain = await plainBytes(zip, dv, o.e);
      if (plain.length < 4 || plain[0] !== 0x1f || plain[1] !== 0x8b) continue;
      o.data = await stream(plain, new DecompressionStream('gzip'));
      let name = m[1] + (m[2].toLowerCase() === 'emz' ? '.emf' : '.wmf');
      for (let n = 2; names.has(name.toLowerCase()); n++) name = m[1] + '_' + n + name.slice(-4); // never overwrite another part
      names.add(name.toLowerCase());
      renamed.set(o.name.split('/').pop(), name.split('/').pop());
      o.name = name;
    }
    if (renamed.size) {
      for (const o of out) {
        if (o.data || !/(^|\/)(\[Content_Types\]\.xml|[^/]+\.rels)$/i.test(o.name)) continue;
        let text = dec.decode(await plainBytes(zip, dv, o.e));
        if (/\.rels$/i.test(o.name)) {
          for (const [from, to] of renamed) text = text.split('/' + from + '"').join('/' + to + '"').split('"' + from + '"').join('"' + to + '"');
        } else {
          const add = [];
          for (const ext of new Set([...renamed.values()].map((n) => n.slice(-3).toLowerCase()))) {
            if (!new RegExp('Extension="' + ext + '"', 'i').test(text)) add.push('<Default Extension="' + ext + '" ContentType="image/x-' + ext + '"/>');
          }
          if (add.length) text = text.replace(/(<Types\b[^>]*>)/, '$1' + add.join(''));
        }
        o.data = enc.encode(text);
      }
    }

    // 2. TCVN3 text
    let tcvnFixed = 0;
    const stylesEntry = byName.get('word/styles.xml');
    let styles = null;
    for (const o of out) {
      if (o.data || !TCVN_PARTS.test(o.name)) continue;
      const xml = dec.decode(await plainBytes(zip, dv, o.e));
      if (!xml.includes(restore ? SHY_ALIAS : SHY)) continue;
      styles ??= vnStyles(stylesEntry ? dec.decode(await plainBytes(zip, dv, stylesEntry.e)) : '');
      const fixed = restore ? fixTcvnText(xml, o.name, styles, SHY_ALIAS, SHY) : fixTcvnText(xml, o.name, styles);
      if (fixed) { o.data = enc.encode(fixed); tcvnFixed++; }
    }
    if (!renamed.size && !tcvnFixed) return same;

    // new package: the changed parts stored uncompressed, everything else copied as it was
    const chunks = [];
    const central = [];
    let pos = 0;
    const u16 = (v) => new Uint8Array([v & 255, v >> 8]);
    const u32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
    const cat = (...parts) => { const b = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of parts) { b.set(p, at); at += p.length; } return b; };
    for (const o of out) {
      const nameBytes = enc.encode(o.name);
      const fresh = o.data != null;
      const body = fresh ? o.data : compressedBytes(zip, dv, o.e);
      const method = fresh ? 0 : o.e.method;
      const crc = fresh ? crc32(o.data) : o.e.crc;
      const csize = body.length;
      const size = fresh ? o.data.length : o.e.size;
      const flags = (o.e.flags & ~0x8) | 0x800; // sizes are in the header (no data descriptor); names are UTF-8
      const local = cat(u32(SIG_LOCAL), u16(20), u16(flags), u16(method), u16(o.e.time), u16(o.e.date), u32(crc), u32(csize), u32(size), u16(nameBytes.length), u16(0), nameBytes);
      central.push(cat(u32(SIG_CENTRAL), u16(20), u16(20), u16(flags), u16(method), u16(o.e.time), u16(o.e.date), u32(crc), u32(csize), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(pos), nameBytes));
      chunks.push(local, body);
      pos += local.length + body.length;
    }
    const cd = cat(...central);
    chunks.push(cd, cat(u32(SIG_EOCD), u16(0), u16(0), u16(out.length), u16(out.length), u32(cd.length), u32(pos), u16(0)));
    return { bytes: cat(...chunks), converted: renamed.size, tcvnFixed };
  } catch {
    return same;
  }
}
