// Edits the font list of sdkjs (sdkjs/common/AllFonts.js) when fonts are taken out of or added to the pack.
//
// AllFonts.js has four parts that must agree: __fonts_files (paths), __fonts_infos (per family: indices of the
// regular, italic, bold and bold italic file), the font selection list (one binary record per file, see
// font-aliases.cjs) and __fonts_ranges (not touched). removeFonts() deletes families and renumbers; addFonts()
// appends families by copying the records of an existing family (same metrics class, so the same panose and unicode
// ranges) under a new name and new files.
'use strict';
const { readRecords, writeRecords, SELECTION_RE, VERSION_RE } = require('./font-aliases.cjs');

const FILES_RE = /(window\["__fonts_files"\]\s*=\s*\[)([\s\S]*?)(\];)/;
const INFOS_RE = /(window\["__fonts_infos"\]\s*=\s*\[)([\s\S]*?)(\];)/;
const STYLES = ['Regular', 'Italic', 'Bold', 'BoldItalic']; // order of the indices in an infos entry

function parse(js) {
  const files = FILES_RE.exec(js);
  const infos = INFOS_RE.exec(js);
  const sel = SELECTION_RE.exec(js);
  const version = VERSION_RE.exec(js);
  if (!files || !infos || !sel || !version || version[1] !== '2') throw new Error('AllFonts.js: unsupported layout');
  return {
    files: JSON.parse('[' + files[2] + ']'),
    infos: JSON.parse('[' + infos[2] + ']'),
    list: readRecords(Buffer.from(sel[2], 'base64')),
  };
}

function render(js, state) {
  const lines = (arr) => '\n' + arr.map((x) => JSON.stringify(x)).join(',\n') + '\n';
  return js
    .replace(FILES_RE, (m, a, b, c) => a + lines(state.files) + c)
    .replace(INFOS_RE, (m, a, b, c) => a + lines(state.infos) + c)
    .replace(SELECTION_RE, (m, a, b, c) => a + writeRecords(state.list).toString('base64') + c);
}

/** First string of a record's `rest` is the file path (int32 length + UTF-8). */
function recordPath(rest) {
  const n = rest.readInt32LE(0);
  return { path: rest.toString('utf8', 4, 4 + n), tail: rest.subarray(4 + n) };
}

function withPath(rest, path) {
  const { tail } = recordPath(rest);
  const b = Buffer.from(path, 'utf8');
  const len = Buffer.alloc(4);
  len.writeInt32LE(b.length);
  return Buffer.concat([len, b, tail]);
}

const baseName = (p) => p.split(/[\\/]/).pop();

/** Removes the families `names`; returns {js, removedFiles}. */
function removeFonts(js, names) {
  const st = parse(js);
  const drop = new Set();
  for (const name of names) {
    const info = st.infos.find((i) => i[0] === name);
    if (!info) continue;
    for (const idx of [info[1], info[3], info[5], info[7]]) if (idx >= 0) drop.add(idx);
  }
  if (!drop.size) return { js, removedFiles: [] };
  const removedFiles = [...drop].map((i) => st.files[i]);
  const gone = new Set(removedFiles.map(baseName));
  st.list.records = st.list.records.filter((r) => !gone.has(baseName(recordPath(r.rest).path)));
  const remap = [];
  const files = [];
  st.files.forEach((f, i) => { remap[i] = drop.has(i) ? -1 : files.push(f) - 1; });
  st.files = files;
  st.infos = st.infos
    .filter((i) => !names.includes(i[0]))
    .map((i) => i.map((v, k) => (k > 0 && k % 2 === 1 && v >= 0 ? remap[v] : v)));
  return { js: render(js, st), removedFiles };
}

/**
 * Adds families. Each: {name, files: {Regular, Italic, Bold, BoldItalic} (file names), cloneFrom: family of the list}.
 * A family already in the list is left alone.
 */
function addFonts(js, families) {
  const st = parse(js);
  const known = new Set(st.infos.map((i) => i[0]));
  let added = 0;
  for (const fam of families) {
    if (known.has(fam.name)) continue;
    const from = st.infos.find((i) => i[0] === fam.cloneFrom);
    if (!from) throw new Error('AllFonts.js: family to copy not found: ' + fam.cloneFrom);
    const entry = [fam.name];
    STYLES.forEach((style, k) => {
      const srcIdx = from[1 + 2 * k];
      const file = fam.files[style];
      if (srcIdx < 0 || !file) { entry.push(-1, -1); return; }
      const path = '/fonts/' + file;
      const idx = st.files.push(path) - 1;
      const srcPath = baseName(st.files[srcIdx]);
      const src = st.list.records.find((r) => baseName(recordPath(r.rest).path) === srcPath);
      if (!src) throw new Error('AllFonts.js: no record for ' + srcPath);
      st.list.records.push({ name: fam.name, names: [], rest: withPath(src.rest, path) });
      entry.push(idx, 0);
    });
    st.infos.push(entry);
    known.add(fam.name);
    added++;
  }
  if (!added) return js;
  st.infos.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return render(js, st);
}

// Last line of AllFonts.js: lets the viewer (the parent page of the editor frame) add the fonts of the user's computer to
// the font list that sdkjs reads next (fonts/local-fonts.mjs). Does nothing without a parent that offers APP.localFonts.
const LOCAL_FONTS_HOOK = ';/*office-wasm:local-fonts*/try{var __p=window.parent;if(__p&&__p!==window&&__p.APP&&typeof __p.APP.localFonts==="function")__p.APP.localFonts(window)}catch(e){}';

/** AllFonts.js with the local fonts hook as its last line (idempotent). */
function addLocalFontsHook(js) {
  if (js.includes('office-wasm:local-fonts')) return js;
  return js.replace(/\s*$/, '\n') + LOCAL_FONTS_HOOK + '\n';
}

module.exports = { removeFonts, addFonts, addLocalFontsHook, parse };
