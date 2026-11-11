// Builds x2t.wasm from source with Docker, on top of the upstream cryptpad/onlyoffice-x2t-wasm Dockerfile.
//   node build/x2t/build.mjs <st|mt> [--no-run] [--progress plain]
//     st  single-threaded, works on any page (no COOP/COEP needed)                -> artifacts/x2t-st/
//     mt  pthreads + SIMD + -O3, needs a cross-origin isolated page (COOP + COEP) -> artifacts/x2t-mt/
// Environment: X2T_JOBS (make parallelism, 8), X2T_MEM (builder memory limit, 8g), X2T_LINK_EXTRA (extra flags for
// the final link, e.g. -sASSERTIONS=1; only the link is redone, the libraries come from the cache).
// The upstream Dockerfile is not edited: a patched copy is generated in build/x2t/.gen/.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const upstream = join(root, 'upstream', 'onlyoffice-x2t-wasm');
const PINNED = '17bd0351'; // upstream commit the replacements below were written against

// finalLflags is baked into the base stage (changing it rebuilds every library); linkExtra is passed with
// X2T_LINK_EXTRA at the final stage, so changing it only redoes the link.
const VARIANTS = {
  st: { opt: '-O2', emccCflags: '', finalLflags: '--emit-symbol-map', linkExtra: '' },
  mt: {
    opt: '-O3 -msimd128',
    emccCflags: '-pthread',
    finalLflags: '--emit-symbol-map -sPTHREAD_POOL_SIZE=x2tPoolSize -sDEFAULT_PTHREAD_STACK_SIZE=2MB',
    // x2t has about 285 MB of static data. A shared (pthreads) memory cannot use the default "static data + heap"
    // sizing of emcc, the link fails with "initial memory too small", so the start size is given here.
    linkExtra: '-sINITIAL_MEMORY=384MB',
  },
};

const variant = process.argv[2];
if (!VARIANTS[variant]) {
  console.error('usage: node build/x2t/build.mjs <st|mt> [--no-run]');
  process.exit(2);
}
const v = VARIANTS[variant];

function replaceOnce(text, from, to, what) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${what}: expected 1 match, found ${n}`);
  return text.replace(from, to);
}

function generate() {
  const head = execFileSync('git', ['-C', upstream, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== PINNED) console.warn(`warning: upstream is at ${head}, replacements were written for ${PINNED}`);
  let d = readFileSync(join(upstream, 'Dockerfile'), 'utf8');

  // 1. knobs + our embuild.sh in the base stage (after emsdk, so both variants share those layers)
  d = replaceOnce(d, 'COPY embuild.sh /bin/embuild.sh\n', [
    'ARG X2T_OPT=-O2',
    'ARG X2T_JOBS=12',
    'ARG X2T_EMCC_CFLAGS=',
    'ARG X2T_FINAL_LFLAGS=',
    'ENV X2T_OPT=$X2T_OPT X2T_JOBS=$X2T_JOBS X2T_FINAL_LFLAGS=$X2T_FINAL_LFLAGS',
    '# emcc adds EMCC_CFLAGS to every compile and link, third-party libraries included',
    'ENV EMCC_CFLAGS=$X2T_EMCC_CFLAGS',
    'COPY --from=ours embuild.sh /bin/embuild.sh',
    'RUN chmod +x /bin/embuild.sh',
    '',
    '',
    '# core sources with our patches applied; every other stage copies from here',
    'FROM base AS src',
    'COPY core /core',
    'COPY --from=ours patch-core.sh /patch-core.sh',
    'COPY --from=ours patches /patches',
    'RUN bash /patch-core.sh',
    '',
  ].join('\n'), 'embuild.sh copy');

  // 2. all later stages take core from the patched copy
  const before = d;
  const marker = 'FROM base AS src\nCOPY core /core\n';
  const [a, b] = d.split(marker);
  d = a + marker + b.replace(/^COPY core/gm, 'COPY --from=src /core');
  if (d === before) throw new Error('COPY core rewrite: nothing replaced');

  // 3. parallel make for the two third-party libraries built outside embuild.sh (openssl, boost)
  const makes = d.split(' && emmake make\n').length - 1;
  if (makes !== 2) throw new Error(`emmake make: expected 2 matches, found ${makes}`);
  d = d.replaceAll(' && emmake make\n', ' && emmake make -j$X2T_JOBS\n');

  // 4. our pre-js
  d = replaceOnce(d, 'COPY pre-js.js /pre-js.js\n', 'COPY --from=ours pre-js.js /pre-js.js\n', 'pre-js copy');

  // 5. final link: extra flags declared here, not in the base stage, so that changing them does not invalidate the
  //    library stages; and no -Wl,-s (base.pri), which strips the function names before emcc can write the symbol
  //    map. emcc removes the names from the wasm itself after writing x2t.symbols.
  d = replaceOnce(d, '    -l "-sALLOW_MEMORY_GROWTH" \\\n    X2tConverter/', '    -l "-sALLOW_MEMORY_GROWTH $X2T_LINK_EXTRA" \\\n    X2tConverter/', 'final link');
  const wrap = 'RUN cat /wrap-main.cpp >> /core/X2tConverter/src/main.cpp\n';
  const noStrip = 'RUN grep -q -- "QMAKE_LFLAGS_RELEASE += -Wl,-s" /core/Common/base.pri && sed -i "s/ += -Wl,-s$/ +=/" /core/Common/base.pri\n';
  d = replaceOnce(d, wrap, wrap + noStrip + 'ARG X2T_LINK_EXTRA=\n', 'final link arg');

  // 6. drop upstream test/output stages (they need a native x2t image and internet samples); add our output
  const cut = d.indexOf('RUN mkdir /test\n');
  if (cut < 0) throw new Error('test section not found');
  d = d.slice(0, cut) + [
    'RUN mkdir /out && cp x2t.js x2t.wasm x2t.js.br x2t.wasm.br /out/ && (cp *.symbols /out/ 2>/dev/null || true) && ls -la /out',
    '',
    'FROM scratch AS ours-output',
    'COPY --from=build /out/ /',
    '',
  ].join('\n');

  mkdirSync(join(here, '.gen'), { recursive: true });
  const out = join(here, '.gen', 'Dockerfile');
  writeFileSync(out, d);
  return out;
}

// The build runs in its own BuildKit container with a memory limit (X2T_MEM, default 8g). Without one, the page
// cache of this I/O-heavy build grows the Docker VM to its full size; on a Windows host with little free commit
// (no pagefile) that takes down the whole WSL VM and every running container with it. Hitting the limit only fails
// the build. Remove the builder and its cache with: docker buildx rm x2t-builder
const BUILDER = process.env.X2T_BUILDER || 'x2t-builder';
function ensureBuilder() {
  if (spawnSync('docker', ['buildx', 'inspect', BUILDER], { stdio: 'ignore' }).status === 0) return;
  const mem = process.env.X2T_MEM || '8g';
  console.log(`creating buildx builder ${BUILDER} (memory limit ${mem})`);
  const r = spawnSync('docker', ['buildx', 'create', '--name', BUILDER, '--driver', 'docker-container', '--driver-opt', 'memory=' + mem, '--buildkitd-config', join(here, 'buildkitd.toml')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const dockerfile = generate();
const outDir = join(root, 'artifacts', 'x2t-' + variant);
const progress = process.argv.includes('--progress') ? process.argv[process.argv.indexOf('--progress') + 1] : 'plain';
const args = [
  'buildx', 'build',
  '--builder', BUILDER,
  '-f', dockerfile,
  '--build-context', 'ours=' + join(here, 'ctx'),
  '--build-arg', 'X2T_OPT=' + v.opt,
  '--build-arg', 'X2T_EMCC_CFLAGS=' + v.emccCflags,
  '--build-arg', 'X2T_FINAL_LFLAGS=' + v.finalLflags,
  '--build-arg', 'X2T_JOBS=' + (process.env.X2T_JOBS || '8'),
  '--build-arg', 'X2T_LINK_EXTRA=' + [v.linkExtra, process.env.X2T_LINK_EXTRA].filter(Boolean).join(' '),
  '--target', 'ours-output',
  '--progress', progress,
  '-o', 'type=local,dest=' + outDir,
  upstream,
];
console.log('docker ' + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
if (process.argv.includes('--no-run')) process.exit(0);
ensureBuilder();
const r = spawnSync('docker', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
