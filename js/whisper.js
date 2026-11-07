// Offline Whisper (sherpa-onnx export) for the browser and Node, using onnxruntime-web.
// Log-mel features match OpenAI Whisper; greedy decoding without timestamps.

export class Whisper {
  constructor(ort) { this.ort = ort; }

  async load({ encoder, decoder, tokensText, melfb }) {
    const ort = this.ort;
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    this.enc = await ort.InferenceSession.create(encoder, opts);
    this.dec = await ort.InferenceSession.create(decoder, opts);
    const md = this.enc.handler && this.enc.handler.metadata ? this.enc.handler.metadata : null;
    // Model constants (same for tiny.en / base.en except layers/state, read from tensor shapes below)
    this.SOT = 50257; this.NO_TS = 50362; this.EOT = 50256;
    this.fb = melfb;
    this.tok = new Map();
    for (const line of tokensText.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length === 2) this.tok.set(+p[1], p[0]);
    }
    this.win = new Float32Array(400);
    for (let i = 0; i < 400; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 400);
    this.cos = new Float32Array(201 * 400); this.sin = new Float32Array(201 * 400);
    for (let k = 0; k <= 200; k++) for (let n = 0; n < 400; n++) {
      const a = 2 * Math.PI * k * n / 400;
      this.cos[k * 400 + n] = Math.cos(a); this.sin[k * 400 + n] = Math.sin(a);
    }
  }

  logMel(x) {
    const N = 480000, T = 3000;
    const a = new Float32Array(N); a.set(x.subarray(0, Math.min(N, x.length)));
    const used = Math.min(T, Math.ceil(Math.min(N, x.length) / 160) + 2);
    const mel = new Float32Array(80 * T);
    const frame = new Float32Array(400), pw = new Float32Array(201);
    const get = (i) => { // reflect padding of 200 at both ends
      let j = i - 200;
      if (j < 0) j = -j; else if (j >= N) j = 2 * (N - 1) - j;
      return a[j];
    };
    let mx = -Infinity;
    for (let t = 0; t < T; t++) {
      if (t < used) {
        for (let n = 0; n < 400; n++) frame[n] = get(t * 160 + n) * this.win[n];
        for (let k = 0; k <= 200; k++) {
          let re = 0, im = 0; const o = k * 400;
          for (let n = 0; n < 400; n++) { re += frame[n] * this.cos[o + n]; im -= frame[n] * this.sin[o + n]; }
          pw[k] = re * re + im * im;
        }
      } else pw.fill(0);
      for (let m = 0; m < 80; m++) {
        const [s, w] = this.fb[m]; let v = 0;
        for (let i = 0; i < w.length; i++) v += w[i] * pw[s + i];
        const l = Math.log10(Math.max(v, 1e-10));
        mel[m * T + t] = l; if (l > mx) mx = l;
      }
    }
    for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], mx - 8) + 4) / 4;
    return mel;
  }

  decodeTokens(ids) {
    const parts = [];
    for (const id of ids) { const b = this.tok.get(id); if (b) parts.push(...atobBytes(b)); }
    return new TextDecoder().decode(new Uint8Array(parts)).trim();
  }

  async _encode(x) {
    const ort = this.ort;
    const mel = new ort.Tensor('float32', this.logMel(x), [1, 80, 3000]);
    const e = await this.enc.run({ mel });
    return { ck: e.n_layer_cross_k, cv: e.n_layer_cross_v };
  }
  _cache(ck) { const L = ck.dims[0], S = ck.dims[3], ort = this.ort; return [0, 1].map(() => new ort.Tensor('float32', new Float32Array(L * 448 * S), [L, 1, 448, S])); }
  _run(cur, off, sk, sv, ck, cv) {
    const ort = this.ort;
    return this.dec.run({
      tokens: new ort.Tensor('int64', BigInt64Array.from(cur.map(BigInt)), [1, cur.length]),
      in_n_layer_self_k_cache: sk, in_n_layer_self_v_cache: sv, n_layer_cross_k: ck, n_layer_cross_v: cv,
      offset: new ort.Tensor('int64', BigInt64Array.from([BigInt(off)]), [1]),
    });
  }
  async _greedy({ ck, cv }) {
    let [sk, sv] = this._cache(ck);
    let cur = [this.SOT, this.NO_TS], off = 0; const out = [];
    for (let step = 0; step < 220; step++) {
      const r = await this._run(cur, off, sk, sv, ck, cv);
      off += cur.length; sk = r.out_n_layer_self_k_cache; sv = r.out_n_layer_self_v_cache;
      const lg = r.logits.data, V = r.logits.dims[2], base = (r.logits.dims[1] - 1) * V;
      let best = 0, bv = -Infinity;
      for (let i = 0; i < V; i++) { const v = lg[base + i]; if (v > bv) { bv = v; best = i; } }
      if (best === this.EOT) break;
      out.push(best); cur = [best];
      if (out.length > 8 && out.slice(-8).every(t => t === best)) break; // repetition guard
    }
    return this.decodeTokens(out);
  }
  // x: Float32Array mono 16 kHz, up to 30 s
  async transcribeChunk(x) { return this._greedy(await this._encode(x)); }

  // Byte-level tokenizer (greedy longest match over the model vocabulary).
  encode(text) {
    if (!this.rev) {
      this.rev = new Map(); this.maxLen = 1;
      for (const [id, b64] of this.tok) { if (id >= this.EOT) continue; const s = String.fromCharCode(...atobBytes(b64)); this.rev.set(s, id); if (s.length > this.maxLen) this.maxLen = s.length; }
    }
    const bytes = new TextEncoder().encode(' ' + String(text).trim().replace(/\s+/g, ' '));
    const s = String.fromCharCode(...bytes); const ids = [], pieces = [];
    for (let i = 0; i < s.length;) {
      let n = Math.min(this.maxLen, s.length - i);
      for (; n > 0; n--) { const sub = s.slice(i, i + n); if (this.rev.has(sub)) { ids.push(this.rev.get(sub)); pieces.push(sub); break; } }
      if (!n) { i++; continue; } i += n;
    }
    return { ids, pieces };
  }

  // Pronunciation analysis: transcript + how strongly the audio supports each word of the reference
  // (teacher-forced probability of the reference tokens; a "goodness of pronunciation" score).
  async analyze(x, refText) {
    const enc = await this._encode(x);
    const text = await this._greedy(enc);
    const { ids, pieces } = this.encode(refText);
    if (!ids.length) return { text, words: [] };
    const [sk, sv] = this._cache(enc.ck);
    const cur = [this.SOT, this.NO_TS, ...ids];
    const r = await this._run(cur, 0, sk, sv, enc.ck, enc.cv);
    const lg = r.logits.data, V = r.logits.dims[2];
    const probs = ids.map((id, j) => {
      const base = (j + 1) * V; let mx = -Infinity;
      for (let i = 0; i < V; i++) if (lg[base + i] > mx) mx = lg[base + i];
      let z = 0; for (let i = 0; i < V; i++) z += Math.exp(lg[base + i] - mx);
      return Math.exp(lg[base + id] - mx) / z;
    });
    // group tokens into words (a new word starts with a space)
    const words = [];
    pieces.forEach((pc, j) => {
      const isNew = pc.startsWith(' ') || !words.length;
      if (isNew) words.push({ word: '', lp: 0, n: 0, min: 1 });
      const w = words[words.length - 1];
      w.word += pc; w.lp += Math.log(Math.max(probs[j], 1e-9)); w.n++; w.min = Math.min(w.min, probs[j]);
    });
    return { text, words: words.map(w => {
      const raw = new TextDecoder().decode(Uint8Array.from([...w.word].map(c => c.charCodeAt(0)))).trim();
      const first = Math.exp(w.lp / w.n);
      return { word: raw, p: +first.toFixed(3), min: +w.min.toFixed(3) };
    }).filter(w => /[a-z0-9]/i.test(w.word)) };
  }

  // Split long audio at quiet points (<=25 s chunks) and transcribe all.
  async transcribe(x, sr = 16000) {
    const f = Math.round(0.02 * sr), cuts = [0];
    while (x.length - cuts[cuts.length - 1] > 25 * sr) {
      const c = cuts[cuts.length - 1], lo = c + 18 * sr, hi = c + 25 * sr;
      let bi = lo, be = Infinity;
      for (let i = lo; i + f <= hi; i += f) {
        let e = 0; for (let j = i; j < i + f; j++) e += x[j] * x[j];
        if (e < be) { be = e; bi = i; }
      }
      cuts.push(bi);
    }
    cuts.push(x.length);
    const texts = [];
    for (let i = 0; i + 1 < cuts.length; i++) texts.push(await this.transcribeChunk(x.subarray(cuts[i], cuts[i + 1])));
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  }
}

function atobBytes(b64) {
  if (typeof atob === 'function') { const s = atob(b64); const a = new Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  return Array.from(Buffer.from(b64, 'base64'));
}
