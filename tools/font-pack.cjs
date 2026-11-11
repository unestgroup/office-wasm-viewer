// Prepares the font pack of the editor for distribution (idempotent):
//   node tools/font-pack.cjs [--check]
//   1. deletes the fonts that may not be redistributed (Arial, Calibri) from artifacts/onlyoffice-editor/fonts/fonts
//   2. copies the Vietnamese legacy fonts (.VnTime, .VnTimeH) next to the others. --vn original (default): the
//      original ABC files (fonts/vn-orig/, licence not stated); --vn open: the OFL rebuild from Tinos (fonts/vn/)
//   3. adds the metric-compatible substitutes (fonts/metric/) and the local fonts hook, rewrites sdkjs/common/AllFonts.js to match (Arial and Calibri then answer to Arimo and Carlito through the
//      aliases that serve.cjs adds, see fonts/font-aliases.cjs)
// --check only reports what would change and exits 1 when the pack still needs the step.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { removeFonts, addFonts, addLocalFontsHook } = require('../fonts/font-pack.cjs');

const ROOT = path.join(__dirname, '..');
const PACK = path.join(ROOT, 'artifacts', 'onlyoffice-editor');
const FONT_DIR = path.join(PACK, 'fonts', 'fonts');
const ALL_FONTS = path.join(PACK, 'sdkjs', 'common', 'AllFonts.js');
const VN_SETS = { original: path.join(ROOT, 'fonts', 'vn-orig', 'patched'), open: path.join(ROOT, 'fonts', 'vn') };
const vnArg = process.argv.includes('--vn') ? process.argv[process.argv.indexOf('--vn') + 1] : 'original';
if (!VN_SETS[vnArg]) throw new Error('--vn original|open');
const VN_DIR = VN_SETS[vnArg];
const vnFiles = (dir) => Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'vn-fonts.json'), 'utf8')).fonts).flatMap((f) => Object.values(f));
const REMOVE = ['Arial', 'Calibri'];
const REMOVE_FILES = /^(arial|calibri)(bd|bi|i|b|z)?\.ttf$/i;
// families this tool added in an earlier version of the metric set (10/11), now replaced by renamed copies with Vietnamese letters
const RETIRED = ['Selawik', 'Selawik Light', 'Selawik Semibold', 'Liberation Sans Narrow', 'Comic Relief'];
const RETIRED_FILES = /^(Selawik|LiberationSansNarrow|ComicRelief)-.*\.ttf$/;

// metric-compatible and closest-match fonts for common Word fonts (fonts/metric/, built by fonts/metric-src)
const METRIC_DIR = path.join(ROOT, 'fonts', 'metric');
const metric = JSON.parse(fs.readFileSync(path.join(METRIC_DIR, 'metric-fonts.json'), 'utf8')).fonts;
const metricFiles = Object.values(metric).flatMap((f) => Object.values(f.files));
const differs = (dir, f) => {
  const dst = path.join(FONT_DIR, f); // missing, or another version of the file
  return !fs.existsSync(dst) || !fs.readFileSync(dst).equals(fs.readFileSync(path.join(dir, f)));
};

const check = process.argv.includes('--check');
const before = fs.readFileSync(ALL_FONTS, 'utf8');
const stale = fs.readdirSync(FONT_DIR).filter((f) => REMOVE_FILES.test(f) || RETIRED_FILES.test(f));
// the other Vietnamese set must go (same family names), then the chosen one is added
const wanted = new Set(vnFiles(VN_DIR));
const otherSets = Object.values(VN_SETS).filter((d) => d !== VN_DIR);
const otherFiles = [...new Set(otherSets.flatMap(vnFiles))].filter((f) => !wanted.has(f) && fs.existsSync(path.join(FONT_DIR, f)));
let js = removeFonts(before, [...REMOVE, ...RETIRED, ...(otherFiles.length ? ['.VnTime', '.VnTimeH'] : [])]).js;
const vn = JSON.parse(fs.readFileSync(path.join(VN_DIR, 'vn-fonts.json'), 'utf8')).fonts;
js = addFonts(js, Object.entries(vn).map(([name, files]) => ({ name, files, cloneFrom: 'Tinos' })));
js = addFonts(js, Object.entries(metric).map(([name, f]) => ({ name, files: f.files, cloneFrom: f.cloneFrom })));
js = addLocalFontsHook(js); // lets the viewer add the fonts of the user's computer (fonts/local-fonts.mjs)
const missingVn = Object.values(vn).flatMap((f) => Object.values(f)).filter((f) => differs(VN_DIR, f));
const missingMetric = metricFiles.filter((f) => differs(METRIC_DIR, f));
console.log(JSON.stringify({ vn: vnArg, otherSetFiles: otherFiles.length, staleFiles: stale.length, vnToCopy: missingVn.length, metricToCopy: missingMetric.length, allFontsChanged: js !== before }));
if (check) process.exit(stale.length || otherFiles.length || missingVn.length || missingMetric.length || js !== before ? 1 : 0);
for (const f of [...stale, ...otherFiles]) fs.unlinkSync(path.join(FONT_DIR, f));
for (const f of missingVn) fs.copyFileSync(path.join(VN_DIR, f), path.join(FONT_DIR, f));
for (const f of missingMetric) fs.copyFileSync(path.join(METRIC_DIR, f), path.join(FONT_DIR, f));
if (js !== before) fs.writeFileSync(ALL_FONTS, js);
console.log('font pack ready: removed ' + stale.length + ' files, added ' + missingVn.length + ', AllFonts.js ' + (js !== before ? 'rewritten' : 'unchanged'));
