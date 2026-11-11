// Names the wasm-function[N] frames of a stack trace with the symbol map of one of our builds.
//   node build/x2t/symbolize.mjs <st|mt> < trace.txt
//   node tools/x2t-run.cjs ... 2>&1 | node build/x2t/symbolize.mjs st
// Function indices are specific to one build: use the map of the build that produced the trace.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'artifacts', 'x2t-' + (process.argv[2] || 'st'));
const mapFile = readdirSync(dir).find((f) => f.endsWith('.symbols'));
if (!mapFile) {
  console.error('no *.symbols file in ' + dir);
  process.exit(2);
}
const names = new Map();
for (const line of readFileSync(join(dir, mapFile), 'utf8').split('\n')) {
  const i = line.indexOf(':');
  // names are escaped like C++\20names\28\29: \xx is a hex character code
  if (i > 0) names.set(line.slice(0, i), line.slice(i + 1).trim().replace(/\\([0-9a-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
}
const text = readFileSync(0, 'utf8').replace(/\\n/g, '\n');
process.stdout.write(text.replace(/wasm-function\[(\d+)\]/g, (m, n) => (names.has(n) ? `${names.get(n)} [${n}]` : m)));
