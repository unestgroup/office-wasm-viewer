// Smoke matrix for an x2t wasm build. Each case runs in its own node process.
// usage: node tools/x2t-smoke.cjs [build] [--samples <dir>] [--out <dir>]
//   build: directory name under artifacts/ - x2t (CryptPad prebuilt, default), x2t-st, x2t-mt
//   --samples  directory with medium.docx, test1.xlsx, simple.pptx (default: ../office-wasm-sdk/samples)
//   --out      output directory (default: ./out[/smoke-<build>])
// SPDX-License-Identifier: AGPL-3.0-or-later
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const opt = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? null : process.argv[i + 1];
};
const BUILD = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'x2t';
const X2T = path.join(ROOT, 'artifacts', BUILD);
const UP = path.join(ROOT, 'upstream', 'onlyoffice-x2t-wasm');
const FONTS = path.join(UP, 'tests', 'fonts');
const S = path.resolve(opt('samples') || path.join(ROOT, '..', 'office-wasm-sdk', 'samples'));
const OUT = path.resolve(opt('out') || path.join(ROOT, 'out', BUILD === 'x2t' ? '' : 'smoke-' + BUILD));
fs.mkdirSync(OUT, { recursive: true });

// format ids from core/Common/OfficeFileFormats.h
const F = { docx: 65, odt: 67, txt: 69, html: 70, pptx: 129, xlsx: 257, csv: 260, pdf: 513, png: 1029, jpg: 1025 };

const cases = [
  // OOXML -> editor binary (what the sdkjs viewer/editor loads)
  { id: 'docx-bin', in: 'medium.docx', out: 'medium.docx.bin' },
  { id: 'xlsx-bin', in: 'test1.xlsx', out: 'test1.xlsx.bin' },
  { id: 'pptx-bin', in: 'simple.pptx', out: 'simple.pptx.bin' },
  // direct text extraction (pure C++)
  { id: 'docx-txt', in: 'medium.docx', out: 'medium.txt', to: F.txt },
  { id: 'xlsx-csv', in: 'test1.xlsx', out: 'test1.csv', to: F.csv },
  { id: 'pptx-txt', in: 'simple.pptx', out: 'simple.txt', to: F.txt },
  // routes that need the JS layout engine (doctrenderer is stubbed in this build)
  { id: 'docx-pdf', in: 'medium.docx', out: 'medium.pdf', to: F.pdf },
  { id: 'xlsx-pdf', in: 'test1.xlsx', out: 'test1.pdf', to: F.pdf },
  { id: 'pptx-pdf', in: 'simple.pptx', out: 'simple.pdf', to: F.pdf },
  { id: 'docx-html', in: 'medium.docx', out: 'medium.html', to: F.html },
  { id: 'docx-png', in: 'medium.docx', out: 'medium.png', to: F.png },
  // format-to-format without layout
  { id: 'docx-odt', in: 'medium.docx', out: 'medium.odt', to: F.odt },
  // upstream fixture: editor bin + pre-rendered pdf.bin -> PDF (the CryptPad export path)
  {
    id: 'fixture-pdfbin-pdf',
    inAbs: path.join(UP, 'tests', 'documentWithImage', 'working', 'output.bin'),
    preload: path.join(UP, 'tests', 'documentWithImage', 'working'),
    out: 'fixture.pdf', to: F.pdf,
  },
];

const report = { node: process.version, x2tWasmBytes: null, x2tJsBytes: null, cases: [] };
for (const f of ['x2t.wasm', 'x2t.js']) {
  const p = path.join(X2T, f);
  report[f === 'x2t.wasm' ? 'x2tWasmBytes' : 'x2tJsBytes'] = fs.existsSync(p) ? fs.statSync(p).size : null;
}

for (const c of cases) {
  const input = c.inAbs || path.join(S, c.in);
  const argv = [path.join(__dirname, 'x2t-run.cjs'), '--x2t', X2T, '--fonts', FONTS, '--in', input, '--out', path.join(OUT, c.out)];
  if (c.to) argv.push('--to', String(c.to));
  if (c.preload) argv.push('--preload', c.preload);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  const entry = { id: c.id, wallMs: Date.now() - t0, processExit: r.status, signal: r.signal || null };
  if (line) Object.assign(entry, JSON.parse(line.slice(7)));
  entry.stderrTail = (r.stderr || '').trim().split('\n').slice(-6).join('\n').slice(-800);
  entry.stdoutTail = (r.stdout || '').split('\n').filter((l) => !l.startsWith('RESULT ')).join('\n').trim().slice(-400);
  delete entry.in; delete entry.out;
  report.cases.push(entry);
  console.log(`${c.id.padEnd(20)} exit=${entry.exitCode ?? 'n/a'} proc=${entry.processExit} out=${entry.outBytes ?? '-'}B init=${entry.initMs ?? '-'}ms conv=${entry.convertMs ?? '-'}ms head=${entry.outHead ?? ''}`);
}
fs.writeFileSync(path.join(OUT, 'smoke-report.json'), JSON.stringify(report, null, 2));
console.log('report: ' + path.join(OUT, 'smoke-report.json'));
