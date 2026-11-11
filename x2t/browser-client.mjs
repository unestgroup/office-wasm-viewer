// Promise API over x2t-worker.js (browser). One worker = one x2t wasm instance; conversions are serialized.
import { FORMAT, buildParamsXml, extOf } from './formats.mjs';

export class X2tClient {
  /**
   * @param {{workerUrl: string|URL, x2tBase: string, x2tBaseMt?: string, threads?: number}} opts
   *   x2tBase:   absolute URL prefix of the single-threaded build (x2t.js + x2t.wasm); works on any page
   *   x2tBaseMt: same for the multi-threaded build; used only when the page is cross-origin isolated
   *              (served with COOP: same-origin + COEP: require-corp), otherwise x2tBase is used
   *   threads:   number of thread workers started in advance by the multi-threaded build (default 2).
   *              The conversions of x2t 9.3.2 start no thread (measured: 0, 1, 2 and 8 give the same times), so a
   *              large pool only costs memory. The small default keeps a thread start from blocking, should a
   *              code path need one: a thread created while the worker is busy cannot start outside the pool.
   */
  constructor(opts) {
    this.opts = opts;
    this.variant = opts.x2tBaseMt && globalThis.crossOriginIsolated ? 'mt' : 'st';
    this.threads = this.variant === 'mt' ? opts.threads ?? 2 : 0;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
    this.queue = Promise.resolve();
  }

  #call(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Start the worker and compile the wasm. Safe to call more than once. */
  init() {
    if (this.ready) return this.ready;
    this.worker = new Worker(this.opts.workerUrl);
    this.worker.onmessage = (ev) => {
      const { id, ok, error, ...rest } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(rest);
      else p.reject(Object.assign(new Error(error), { log: rest.log }));
    };
    this.worker.onerror = (ev) => {
      const err = new Error('x2t worker error: ' + (ev.message || 'unknown'));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.terminate();
    };
    const base = this.variant === 'mt' ? this.opts.x2tBaseMt : this.opts.x2tBase;
    this.ready = this.#call({ type: 'init', base, threads: this.threads }).then((r) => ({ ...r, variant: this.variant, threads: this.threads }));
    this.ready.catch(() => this.terminate());
    return this.ready;
  }

  /** Fonts are only needed when x2t writes a PDF. */
  async loadFonts(base, files) {
    await this.init();
    return this.#call({ type: 'fonts', base, files });
  }

  /** Replaces the fonts of the user's computer that x2t sees (file name -> bytes, names start with "local-font-"). */
  async setLocalFonts(files) {
    await this.init();
    return this.#call({ type: 'localFonts', files });
  }

  /**
   * @param {{name: string, data: Uint8Array, to: string, formatTo?: number, files?: Record<string, Uint8Array>, extraXml?: string}} job
   *   name: input file name (the extension matters), to: output file name ("Editor.bin", "out.txt", "out.pdf" ...)
   * @returns {Promise<{exitCode: number, convertMs: number, output: Uint8Array|null, media: Record<string, Uint8Array>, log: string[]}>}
   */
  convert(job) {
    const run = async () => {
      await this.init();
      const formatTo = job.formatTo ?? (extOf(job.to) === 'bin' ? undefined : FORMAT[extOf(job.to)]);
      const paramsXml = buildParamsXml({
        fileFrom: '/working/' + job.name,
        fileTo: '/working/' + job.to,
        formatTo,
        extraXml: job.extraXml,
      });
      try {
        return await this.#call({ type: 'convert', inputName: job.name, input: job.data, outputName: job.to, paramsXml, files: job.files });
      } catch (e) {
        this.terminate(); // the wasm instance may be poisoned after an abort
        throw e;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = null;
  }
}
