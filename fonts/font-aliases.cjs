// Font aliases for the sdkjs font list (sdkjs/common/AllFonts.js).
//
// sdkjs picks the font file for a document font name by scoring every record of window["g_fonts_selection_bin"]
// (name, panose, unicode ranges, ...). With the CryptPad font pack that search maps "Times New Roman" to DejaVu Sans
// although the pack contains Tinos, which has the same metrics as Times New Roman. A record can carry extra names
// (the other family names of the font file); a request for one of them is an exact name match. An alias here adds
// the missing name to the records of a font in the pack, so line and page breaks stay close to those of MS Office.
//
// Only metric-compatible pairs belong here. A font without a metric-compatible replacement in the pack
// (Century Gothic, Cambria Math, ...) is left to the scoring.
const FONT_ALIASES = {
  'Times New Roman': 'Tinos',
  Times: 'Tinos',
  'Liberation Serif': 'Tinos',
  'Courier New': 'Cousine',
  'Liberation Mono': 'Cousine',
  Helvetica: 'Arimo',
  'Liberation Sans': 'Arimo',
  Cambria: 'Caladea',
  // The pack no longer ships Arial and Calibri (not redistributable, see NOTICE.md): the metric-compatible fonts answer to their names.
  Arial: 'Arimo',
  Calibri: 'Carlito',
  // Common Word fonts without a metric-compatible font of their own: the closest one with all Vietnamese letters, picked
  // by comparing advance widths with the Windows fonts (docs/analysis.md section 17).
  'Trebuchet MS': 'Carlito',
  'Calibri Light': 'Carlito',
  'Lucida Console': 'Cousine',
  Consolas: 'Cousine', // monospaced; Consolas is about 9% narrower
  'Microsoft Sans Serif': 'Arimo',
};

// Families added by tools/font-pack.cjs from fonts/metric/ (Georgia -> Gelasio, Segoe UI -> Selawik, ...): the names
// they answer to are listed in fonts/metric/metric-fonts.json.
try {
  const metric = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'metric', 'metric-fonts.json'), 'utf8'));
  for (const [family, info] of Object.entries(metric.fonts)) for (const alias of info.aliases) FONT_ALIASES[alias] = family;
} catch { /* the metric set is not there: those names stay with the scoring */ }

const SELECTION_RE = /(window\["g_fonts_selection_bin"\]\s*=\s*")([A-Za-z0-9+/=]*)(")/;
const VERSION_RE = /window\["__all_fonts_js_version__"\]\s*=\s*(\d+)/;

/**
 * Reads the selection list: int32 count, then per record
 * int32 recordLen (whole record), string name, int32 n, n strings (extra names), rest. A string is int32 length + UTF-8.
 */
function readRecords(buf) {
  const count = buf.readInt32LE(0);
  const records = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const len = buf.readInt32LE(pos);
    if (len < 12 || pos + len > buf.length) throw new Error('AllFonts.js: bad record length in g_fonts_selection_bin');
    let p = pos + 4;
    const str = () => {
      const n = buf.readInt32LE(p);
      const s = buf.toString('utf8', p + 4, p + 4 + n);
      p += 4 + n;
      return s;
    };
    const name = str();
    const nameCount = buf.readInt32LE(p);
    p += 4;
    const names = [];
    for (let k = 0; k < nameCount; k++) names.push(str());
    records.push({ name, names, rest: buf.subarray(p, pos + len) });
    pos += len;
  }
  return { records, tail: buf.subarray(pos) };
}

function writeRecords({ records, tail }) {
  const int = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const str = (s) => { const b = Buffer.from(s, 'utf8'); return [int(b.length), b]; };
  const parts = [int(records.length)];
  for (const r of records) {
    const body = Buffer.concat([...str(r.name), int(r.names.length), ...r.names.flatMap(str), r.rest]);
    parts.push(int(body.length + 4), body);
  }
  parts.push(tail);
  return Buffer.concat(parts);
}

/**
 * Returns the text of AllFonts.js in which every record of an alias target also answers to the alias name.
 * An alias is skipped when its own name is a font of the list or its target is not. Throws when the list is not
 * found or has another format version than 2 (the file format changed).
 * @param {string} allFontsJs content of sdkjs/common/AllFonts.js
 * @param {Record<string, string>} [aliases] alias name -> name of a font in the list
 */
function addFontAliases(allFontsJs, aliases = FONT_ALIASES) {
  const m = SELECTION_RE.exec(allFontsJs);
  if (!m) throw new Error('AllFonts.js: g_fonts_selection_bin not found');
  const version = VERSION_RE.exec(allFontsJs);
  if (!version || version[1] !== '2') throw new Error('AllFonts.js: unsupported font list version ' + (version ? version[1] : '(none)'));
  const list = readRecords(Buffer.from(m[2], 'base64'));
  const known = new Set(list.records.flatMap((r) => [r.name, ...r.names]));
  for (const [alias, target] of Object.entries(aliases)) {
    if (known.has(alias) || !known.has(target)) continue;
    for (const r of list.records) if (r.name === target) r.names.push(alias);
  }
  return allFontsJs.slice(0, m.index) + m[1] + writeRecords(list).toString('base64') + m[3] + allFontsJs.slice(m.index + m[0].length);
}

module.exports = { FONT_ALIASES, addFontAliases, readRecords, writeRecords, SELECTION_RE, VERSION_RE };
