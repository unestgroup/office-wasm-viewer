# Building x2t.wasm from source

`x2t` is the OnlyOffice/Euro-Office converter (C++, AGPL-3.0). We build it with the Dockerfile of
`upstream/onlyoffice-x2t-wasm` (CryptPad), without editing that repository: `build.mjs` generates a patched copy of
the Dockerfile in `build/x2t/.gen/` and passes our files as a second build context.

```
node build/x2t/build.mjs st     # -> artifacts/x2t-st/   single-threaded, runs on any page
node build/x2t/build.mjs mt     # -> artifacts/x2t-mt/   pthreads + SIMD, needs COOP + COEP
```

Needs Docker with BuildKit (Docker Desktop is fine) and about 30 GB of Docker disk.
A cold build takes on the order of an hour; reruns reuse the layer cache. `X2T_JOBS=<n>` sets make parallelism (default 8).

The build runs in its own BuildKit container, `x2t-builder`, created on first use with a memory limit
(`X2T_MEM`, default `8g`) and at most two stages at a time (`buildkitd.toml`; BuildKit otherwise starts every ready
stage at once, each with `make -j8`). Both matter on Windows: without them the compilers and the page cache of this
build grow the WSL VM to its full size, and when the host runs out of commit (no pagefile) Windows kills the whole
VM, stopping every running container. With the limits the worst case is a failed build, which resumes from the layer
cache on the next run. `docker buildx rm x2t-builder` removes the builder and its cache.

On a host with little free memory, watch the commit headroom during the build and give the VM page cache back when it
gets low: `wsl -d docker-desktop -u root sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"`.

What invalidates the cache:

| Change | Rebuilt |
|---|---|
| `X2T_LINK_EXTRA` (e.g. `-sASSERTIONS=1`) | the final link only (a few minutes) |
| a patch in `ctx/patches/` | every stage that copies the patched directory; for `DesktopEditor/` that is nearly all of them |
| `X2T_JOBS`, `ctx/embuild.sh`, the variant (`st`/`mt`) | everything after emsdk |

## The two variants

| | `st` | `mt` |
|---|---|---|
| Page requirements | none | `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`crossOriginIsolated === true`), because it uses `SharedArrayBuffer` |
| Flags | `-O2` | `-O3 -msimd128 -pthread` for every library, thread pool sized at start (`Module.pthreadPoolSize`), `-sINITIAL_MEMORY=384MB` on the link (x2t has about 285 MB of static data and a shared memory cannot use emcc's default sizing: `initial memory too small`) |
| Files | `x2t.js`, `x2t.wasm` (+ `.br`), `x2t.symbols` | same plus the pthread support in `x2t.js` |

`x2t/browser-client.mjs` picks `mt` only when the page is cross-origin isolated and an `mt` base URL was given;
otherwise it uses `st`. `tools/serve.cjs --coi` serves the viewer with COOP + COEP + CORP (`poc/preview/server.cjs --coi` does it for the demo host and the viewer).

The conversions of core 9.3.2 start no thread, so `mt` is not faster than `st` today (measured with pools of 0, 1, 2
and 8 threads; see `docs/analysis.md` section 7). It is the base for parallel work inside the core; the client starts
a pool of 2.

## What differs from upstream

- `ctx/embuild.sh` replaces upstream `embuild.sh`: optimisation level from `X2T_OPT` (upstream: `-Os`), main stack
  4 MB (upstream: 128 KB), `--emit-symbol-map` on the final link.
- The final link no longer passes `-Wl,-s` (it removed the function names before the symbol map was written; emcc
  strips the wasm itself afterwards). `x2t.symbols` maps function index to C++ name; it is not needed at run time.
  To read a crash: `node tools/x2t-run.cjs ... 2>&1 | node build/x2t/symbolize.mjs st`.
- `ctx/pre-js.js`: upstream file plus the thread pool size variable.
- `ctx/patches/*.patch`: fixes to the `core` sources, applied by `ctx/patch-core.sh` in a `src` stage that all other
  stages copy from.
- Upstream test and output stages are dropped (they need the native document server image and internet samples);
  our checks are `npm run smoke:x2t` and `npm run e2e`.
- openssl and boost are built with `make -j`.

### Patches

- `0001-svg-css-calculator-layout.patch`: fixes `memory access out of bounds` on every document that contains a
  metafile (WMF, EMF or SVG; for example MathType equation previews). Upstream compiles the SVG code of `graphics`
  without `CSS_CALCULATOR_WITH_XHTML` but links the single copy of the CSS calculator that `HtmlFile2` compiles with
  it. The classes `CCssCalculator_Private`, `CStyleStorage` and `CNode` have more members with the define, so
  `CSvgCalculator` allocated an object smaller than the code operating on it expected and the heap was corrupted
  (crash in `~CMetaFile`). The patch adds the define to the `graphics` build. The prebuilt CryptPad `x2t.wasm` has
  the same defect; the native OnlyOffice build does not, because there the two are separate shared libraries.

Patch paths are relative to `core/` (`a/OOXML/...`, `b/OOXML/...`). To make one, edit the file under
`upstream/onlyoffice-x2t-wasm/core`, then
`git -C upstream/onlyoffice-x2t-wasm diff --relative=core -- core > build/x2t/ctx/patches/0001-name.patch`
and restore the upstream file (`git checkout -- core/...`) so the patch is the only copy of the change.

## Licence

Everything in this directory, and every patch to `core`, is a modification of an AGPL-3.0 program and is published
under AGPL-3.0 together with the build output.
