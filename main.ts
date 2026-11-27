// PNG Squeeze v2 — "Optimal-parse squeeze": an optimal-parsing (shortest-path, zopfli-style)
// DEFLATE compressor over palette / colour-type reduced, per-row minsum-filtered screenshots.
// Written from the kit spec (RULES.txt / competition.yaml) only.
// Node 22, no dependencies beyond node:zlib / node:fs.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const WIDTH = 1280;
const HEIGHT = 720;

// ---------------------------------------------------------------- PNG primitives
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0); out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2); out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8; d[9] = colourType;
  return d;
}

// Decode a stored (or any valid) PNG the contest reads into RGBA.
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null, palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      header = { width: view.getUint32(8 + 0), height: 0, colourType: 0 };
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const { width, height, colourType } = header;
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const stride = width * ch;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= ch ? samples[o + i - ch] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= ch ? samples[o + i - ch] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= ch ? samples[o + i - ch] : 0;
      const b = y > 0 ? samples[p + i] : 0;
      const c = y > 0 && i >= ch ? samples[p + i - ch] : 0;
      samples[o + i] = raw[src + i] + paeth(a, b, c);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- image analysis
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
    });
  }
  return { opaque, grey, colours };
}
// The one fully transparent value the image may key by tRNS instead of an alpha channel.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, order });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, order: null });
  return forms;
}

// ---------------------------------------------------------------- filtering
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}
// Filter every row of `samples` by `choice` (a fixed filter 0-4, or 'minsum': per row the
// filter whose bytes have the least signed sum). Returns the raw scanline data.
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const s = signedSum(trial[t]);
      if (s < best) { best = s; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
// Screen forms with zlib level 6 and keep the smallest (form, filter choice, filtered data).
function screen(rgba) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const choices = form.colourType === 3
      ? (form.order === 'count' ? [0] : [0, 'minsum'])
      : [0, 1, 2, 3, 4, 'minsum'];
    for (const choice of choices) {
      const data = filtered(form.samples, WIDTH, HEIGHT, form.bpp, choice);
      const zlib = deflateSync(data, { level: 6, memLevel: 8 });
      const bytes = zlib.length + chunkBytes(form);
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  return best;
}

// ---------------------------------------------------------------- DEFLATE tables
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// length symbol for a match length (3..258), and its extra bits value.
function lenSym(len) {
  let s = 0;
  while (s < 28 && LEN_BASE[s + 1] <= len) s++;
  return s;
}
function distSym(d) {
  let s = 0;
  while (s < 29 && DIST_BASE[s + 1] <= d) s++;
  return s;
}
// Fixed Huffman code lengths (RFC 1951).
const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;

// Length-limited Huffman code lengths from frequencies (two-queue tree build; when the
// tree is deeper than maxLen, a Kraft-budget promotion from flat lengths). The result is
// a complete prefix code (Kraft sum exactly 1, except for a lone symbol, which zlib
// accepts at length 1 for lit/dist alphabets): inflate rejects an incomplete dynamic
// code whose longest length exceeds 1, so completeness is enforced here, with dummy
// codes on unused alphabet entries and, failing that, by shortening the longest,
// least-frequent codes (which provably never overshoots the Kraft target).
function completeKraft(lengths, freq, maxLen) {
  const target = 1 << maxLen;
  let kraft = 0;
  for (let s = 0; s < lengths.length; s++) if (lengths[s] > 0) kraft += 1 << (maxLen - lengths[s]);
  if (kraft === target) return;
  if (kraft > target) { // over-subscribed: should not happen; fall back to flat lengths
    const used = [];
    for (let s = 0; s < lengths.length; s++) if (freq[s] > 0) used.push(s);
    const L = Math.ceil(Math.log2(Math.max(2, used.length)));
    for (const s of used) lengths[s] = Math.min(L, maxLen);
    kraft = 0;
    for (let s = 0; s < lengths.length; s++) if (lengths[s] > 0) kraft += 1 << (maxLen - lengths[s]);
    if (kraft === target) return;
  }
  let deficit = target - kraft;
  // Dummy codes on unused alphabet entries, one per 1-bit of the deficit.
  const unused = [];
  for (let s = 0; s < lengths.length; s++) if (lengths[s] === 0 && freq[s] === 0) unused.push(s);
  if (unused.length >= 32 - Math.clz32(deficit)) {
    let u = 0;
    for (let e = maxLen - 1; e >= 0 && deficit > 0; e--) {
      const bit = 1 << e;
      if (deficit >= bit) { lengths[unused[u++]] = maxLen - e; deficit -= bit; }
    }
    if (deficit === 0) return;
  }
  // Shorten the longest, least-frequent codes: each shortening adds exactly
  // 2^(maxLen - L) Kraft units, and the deficit stays a multiple of that unit.
  while (deficit > 0) {
    let L = 0, sym = -1;
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s] > L || (lengths[s] === L && sym >= 0 && freq[s] < freq[sym])) { L = lengths[s]; sym = s; }
    }
    if (L <= 1 || sym < 0) break;
    const add = 1 << (maxLen - L);
    if (add > deficit) break; // safety valve; the invariant says this never happens
    lengths[sym] = L - 1;
    deficit -= add;
  }
}
function buildLengths(freq, maxLen, needComplete = false) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    if (needComplete) {
      // A lone code is incomplete; pair it with a dummy code on an unused entry.
      for (let i = 0; i < n; i++) if (freq[i] === 0) { lengths[i] = 1; break; }
    }
    return lengths;
  }
  // Tree nodes: leaves 0..used.length-1, internal nodes after. Two queues, both ascending.
  const nodes = []; // {freq, sym, left, right}
  const order = [...used].sort((a, b) => freq[a] - freq[b] || a - b);
  for (const s of order) nodes.push({ freq: freq[s], sym: s, left: null, right: null });
  let q1 = 0; // next leaf
  const q2 = []; // combined nodes, in creation order (ascending freq)
  let q2i = 0;
  const takeMin = () => {
    const a = q1 < nodes.length ? nodes[q1] : null;
    const b = q2i < q2.length ? q2[q2i] : null;
    if (b === null || (a !== null && a.freq <= b.freq)) { q1++; return a; }
    q2i++; return b;
  };
  let root = null;
  const total = nodes.length;
  for (let k = 0; k < total - 1; k++) {
    const x = takeMin(), y = takeMin();
    const node = { freq: x.freq + y.freq, sym: -1, left: x, right: y };
    q2.push(node);
    root = node;
  }
  // Depths by traversal.
  const depthOf = new Map();
  const stack = [[root, 0]];
  let maxDepth = 0;
  while (stack.length) {
    const [nd, d] = stack.pop();
    if (nd.sym >= 0) { depthOf.set(nd.sym, d); if (d > maxDepth) maxDepth = d; }
    else { stack.push([nd.left, d + 1]); stack.push([nd.right, d + 1]); }
  }
  if (maxDepth <= maxLen) {
    for (const s of used) lengths[s] = depthOf.get(s);
    completeKraft(lengths, freq, maxLen);
    return lengths;
  }
  // Length limit: start every symbol at maxLen (Kraft k * 2^-maxLen <= 1, since the
  // alphabets here hold far fewer symbols than 2^maxLen) and promote the most frequent
  // symbols to shorter lengths while the Kraft budget allows. The overflow case is
  // rare and the loss vs the unconstrained tree is tiny.
  const budget0 = (1 << maxLen) - used.length; // Kraft budget in units of 2^-maxLen
  let budget = budget0;
  const byFreq = [...used].sort((a, b) => freq[b] - freq[a] || a - b);
  for (const s of byFreq) {
    let len = maxLen;
    while (len > 1) {
      const cost = 1 << (maxLen - len); // Kraft units to promote len -> len-1
      if (cost > budget) break;
      budget -= cost;
      len--;
    }
    lengths[s] = len;
  }
  completeKraft(lengths, freq, maxLen);
  return lengths;
}
// Canonical codes from lengths: returns {codes: Uint32Array, lens: Uint8Array}.
function canonicalCodes(lengths) {
  const n = lengths.length;
  const count = new Uint32Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const next = new Uint32Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + count[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len !== 0) codes[i] = next[len]++;
  }
  return { codes, lens: lengths };
}

// ---------------------------------------------------------------- bit writer
class BitWriter {
  constructor(capacity) {
    this.out = new Uint8Array(Math.max(1024, capacity));
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  grow() {
    const bigger = new Uint8Array(this.out.length * 2);
    bigger.set(this.out.subarray(0, this.pos));
    this.out = bigger;
  }
  put(code, len) {
    // DEFLATE packs Huffman codes LSB-first; `code` here is the canonical code with its
    // bits reversed already by the caller convention below (we reverse at emit time).
    this.bitBuf |= code << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      if (this.pos >= this.out.length) this.grow();
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  putReversed(code, len) {
    // Reverse `len` bits of code (canonical codes are MSB-first; DEFLATE writes LSB-first).
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | ((code >>> i) & 1); }
    this.put(r, len);
  }
  align() {
    if (this.bitCnt > 0) {
      if (this.pos >= this.out.length) this.grow();
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0; this.bitCnt = 0;
    }
  }
  bytes() { return this.out.subarray(0, this.pos); }
}

// ---------------------------------------------------------------- LZ77 machinery
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
function hash3(d, i) {
  return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) * 2654435761) >>> 17 & HASH_MASK;
}
// Longest match of d[i..] against d[j..], capped at maxLen. Word-wise compare via the
// Uint32Array view (u32at reads the 4 bytes at any offset, handling misalignment).
// `u32` must cover d plus 8 bytes of zero padding past its end.
function u32at(u32, i) {
  const k = i >> 2, r = (i & 3) << 3;
  if (r === 0) return u32[k];
  return ((u32[k] >>> r) | (u32[k + 1] << (32 - r))) >>> 0;
}
function matchLen(d, u32, i, j, maxLen) {
  let len = 0;
  while (len + 4 <= maxLen) {
    const a = u32at(u32, i + len);
    const b = u32at(u32, j + len);
    if (a !== b) {
      const x = (a ^ b) >>> 0; // little-endian: lowest byte is the first byte
      if ((x & 0xff) !== 0) return len;
      if ((x & 0xff00) !== 0) return len + 1;
      if ((x & 0xff0000) !== 0) return len + 2;
      return len + 3;
    }
    len += 4;
  }
  while (len < maxLen && d[i + len] === d[j + len]) len++;
  return len;
}
// Find matches starting at position i: walks the hash chain (newest first = smallest
// distance first), returns {longest, segStarts, segDists} where segStarts[k] is the first
// length of a segment whose best (smallest) distance is segDists[k].
// `head`/`prev` hold chains of positions < i (i not yet inserted).
function findMatches(d, u32, i, n, head, prev, chainLimit) {
  const maxLen = Math.min(258, n - i);
  if (maxLen < 3 || i + 2 >= n) return { longest: 0, segStarts: null, segDists: null };
  const h = hash3(d, i);
  let cand = head[h];
  let count = 0;
  let longest = 0;
  const segStarts = [];
  const segDists = [];
  while (cand !== -1 && count < chainLimit) {
    const dist = i - cand;
    if (dist > 32768) break;
    count++;
    // Quick reject: if the byte at offset `longest` differs, this candidate cannot beat it.
    if (longest > 0 && longest < maxLen && d[cand + longest] !== d[i + longest]) {
      cand = prev[cand];
      continue;
    }
    const len = matchLen(d, u32, i, cand, maxLen);
    if (len > longest) {
      segStarts.push(longest + 1);
      segDists.push(dist);
      longest = len;
      if (len >= maxLen) break;
    }
    cand = prev[cand];
  }
  return { longest, segStarts, segDists };
}

// ---------------------------------------------------------------- optimal-parse DEFLATE
const BLOCK_SIZE = 262144;
const GREEDY_CHAIN = 64;
const DP_CHAIN = 128;
// No jump: positions are never skipped. The jump (covering a periodic stretch with
// forced 258-chunks) measured worse than the free DP on this data, and the DP's work
// is already bounded by the fixed chain limits, so the wall budget is met by work,
// not by the clock (which the program never reads).
const JUMP_MIN = 1000000000;

function insertPos(d, pos, n, head, prev) {
  if (pos + 2 >= n) return;
  const h = hash3(d, pos);
  prev[pos] = head[h];
  head[h] = pos;
}

// Greedy lazy parse of one block, only to gather symbol frequencies for the cost model.
// Chains (head/prev) are the instance's, built incrementally; positions are inserted as
// the parse advances. Long periodic stretches are emitted as 258-chunks (the "jump").
function greedyBlock(d, u32, start, end, n, head, prev, litFreq, distFreq) {
  let i = start;
  while (i < end) {
    const m = findMatches(d, u32, i, end, head, prev, GREEDY_CHAIN);
    if (m.longest >= 3) {
      if (m.longest >= JUMP_MIN) {
        const d0 = m.segDists[m.segDists.length - 1];
        let R = m.longest;
        while (i + R + 4 <= end && u32at(u32, i + R) === u32at(u32, i + R - d0)) R += 4;
        while (i + R < end && d[i + R] === d[i + R - d0]) R++;
        // Emit R bytes as matches at distance d0.
        let nfull = Math.floor(R / 258), rem = R - 258 * nfull;
        const chunks = [];
        if (rem === 0) { for (let k = 0; k < nfull; k++) chunks.push(258); }
        else if (rem >= 3) { for (let k = 0; k < nfull; k++) chunks.push(258); chunks.push(rem); }
        else { for (let k = 0; k < nfull - 1; k++) chunks.push(258); chunks.push(258 - (3 - rem)); chunks.push(3); }
        for (const cl of chunks) {
          const ls = lenSym(cl);
          litFreq[257 + ls]++;
          distFreq[distSym(d0)]++;
          for (let k = 0; k < cl; k++) { insertPos(d, i + k, n, head, prev); }
          i += cl;
        }
        continue;
      }
      // Lazy: a longer match at i+1 wins over this one.
      insertPos(d, i, n, head, prev);
      const m2 = findMatches(d, u32, i + 1, end, head, prev, 8);
      if (m2.longest > m.longest) {
        litFreq[d[i]]++;
        i++;
        continue;
      }
      const ls = lenSym(m.longest);
      const d0 = m.segDists[m.segDists.length - 1];
      litFreq[257 + ls]++;
      distFreq[distSym(d0)]++;
      for (let k = 1; k < m.longest; k++) insertPos(d, i + k, n, head, prev);
      i += m.longest;
    } else {
      litFreq[d[i]]++;
      insertPos(d, i, n, head, prev);
      i++;
    }
  }
}

// The DP optimal parse of one block. `litLen`/`distLen` are the cost model's code
// lengths; `lenCost`/`distCost` the per-length / per-distance bit costs (incl. extras).
// Returns the symbol stream as two parallel arrays: syms (literal byte, or 257+lenSym
// for a match) and dists (0 for a literal, the distance for a match).
function dpBlock(d, u32, start, end, n, head, prev, litLen, distLen, lenCost, distCost) {
  const blen = end - start;
  const cost = new Float64Array(blen + 1).fill(Infinity);
  const choiceLen = new Uint16Array(blen + 1);
  const choiceDist = new Uint16Array(blen + 1);
  const dead = new Uint8Array(blen + 1);
  cost[0] = 0;
  // Length-code range ends (for the cell-max evaluation of match lengths).
  const rangeEnds = [];
  for (let s = 0; s < 29; s++) {
    const re = s === 28 ? 258 : LEN_BASE[s] + (1 << LEN_EXTRA[s]) - 1;
    if (re > 12) rangeEnds.push(re);
  }
  for (let i = 0; i < blen; i++) {
    const g = start + i;
    if (!dead[i] && cost[i] < Infinity) {
      // Literal.
      const nc0 = cost[i] + litLen[d[g]];
      if (nc0 < cost[i + 1]) { cost[i + 1] = nc0; choiceLen[i + 1] = 1; choiceDist[i + 1] = 0; }
      // Matches.
      const m = findMatches(d, u32, g, end, head, prev, DP_CHAIN);
      if (m.longest >= 3) {
        for (let s = 0; s < m.segStarts.length; s++) {
          // Segments may start below 3 (a candidate whose match is only 1-2 bytes);
          // lengths under 3 are not valid DEFLATE matches, so clamp them away.
          const segStart = Math.max(3, m.segStarts[s]);
          const segEnd = s + 1 < m.segStarts.length ? m.segStarts[s + 1] - 1 : m.longest;
          if (segEnd < segStart) continue;
          const dd = m.segDists[s];
          const dc = distCost[dd];
          let lastEval = -1;
          const evalLen = (l) => {
            if (l === lastEval || l < segStart || l > segEnd) return;
            lastEval = l;
            const nc = cost[i] + lenCost[l] + dc;
            if (nc < cost[i + l]) { cost[i + l] = nc; choiceLen[i + l] = l; choiceDist[i + l] = dd; }
          };
          for (let l = segStart; l <= Math.min(segEnd, 12); l++) evalLen(l);
          for (const re of rangeEnds) if (re > 12 && re <= segEnd) evalLen(re);
          evalLen(segEnd);
        }
        // Jump: a long periodic stretch is covered by 258-chunks at one distance.
        if (m.longest >= JUMP_MIN) {
          const d0 = m.segDists[m.segDists.length - 1];
          let R = m.longest;
          while (g + R + 4 <= end && u32at(u32, g + R) === u32at(u32, g + R - d0)) R += 4;
          while (g + R < end && d[g + R] === d[g + R - d0]) R++;
          let nfull = Math.floor(R / 258), rem = R - 258 * nfull;
          const chunks = [];
          if (rem === 0) { for (let k = 0; k < nfull; k++) chunks.push(258); }
          else if (rem >= 3) { for (let k = 0; k < nfull; k++) chunks.push(258); chunks.push(rem); }
          else { for (let k = 0; k < nfull - 1; k++) chunks.push(258); chunks.push(258 - (3 - rem)); chunks.push(3); }
          let at = i;
          for (const cl of chunks) {
            const nc = cost[i] + lenCost[cl] + distCost[d0];
            if (nc < cost[at + cl]) { cost[at + cl] = nc; choiceLen[at + cl] = cl; choiceDist[at + cl] = d0; }
            for (let q = at + 1; q < at + cl; q++) dead[q] = 1;
            at += cl;
          }
        }
      }
    }
    insertPos(d, g, n, head, prev);
  }
  // Backtrack.
  const syms = [];
  const dists = [];
  const lens = []; // actual match length, 0 for a literal
  let pos = blen;
  while (pos > 0) {
    const len = choiceLen[pos];
    const dist = choiceDist[pos];
    if (len === 1) { syms.push(d[start + pos - 1]); dists.push(0); lens.push(0); }
    else { syms.push(257 + lenSym(len)); dists.push(dist); lens.push(len); }
    pos -= len;
  }
  syms.reverse();
  dists.reverse();
  lens.reverse();
  return { syms, dists, lens };
}

// Emit one block's symbols with dynamic or fixed Huffman, whichever is fewer bits.
function emitBlock(bw, syms, dists, lens, isFinal) {
  // Frequencies of the DP parse.
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    litFreq[s]++;
    if (dists[k] > 0) distFreq[distSym(dists[k])]++;
  }
  litFreq[256]++; // end of block
  const hasMatch = dists.some((x) => x > 0);
  // Dynamic code lengths from the DP frequencies.
  const litLens = buildLengths(litFreq, 15);
  // A block with no matches still gets a dynamic block: the distance alphabet gets a
  // single dummy 1-bit code (never emitted), which inflate accepts.
  const distLens = hasMatch ? buildLengths(distFreq, 15) : Uint8Array.of(1, ...new Uint8Array(29));
  // How many lit / dist codes the dynamic header must carry.
  let hlit = 257, hdist = 1;
  for (let s = 287; s >= 257; s--) if (litLens[s] > 0) { hlit = s + 1; break; }
  for (let s = 29; s >= 1; s--) if (distLens[s] > 0) { hdist = s + 1; break; }
  // RLE-encode the combined code lengths.
  const combined = new Uint8Array(hlit + hdist);
  combined.set(litLens.subarray(0, hlit), 0);
  combined.set(distLens.subarray(0, hdist), hlit);
  const clSyms = []; // [symbol, extraValue, extraBits]
  const clFreq = new Uint32Array(19);
  {
    let k = 0;
    while (k < combined.length) {
      const v = combined[k];
      let run = 1;
      while (k + run < combined.length && combined[k + run] === v) run++;
      if (v === 0) {
        let left = run;
        while (left >= 11) { const take = Math.min(left, 138); clSyms.push([18, take - 11, 7]); clFreq[18]++; left -= take; }
        if (left >= 3) { clSyms.push([17, left - 3, 3]); clFreq[17]++; left = 0; }
        while (left > 0) { clSyms.push([0, 0, 0]); clFreq[0]++; left--; }
      } else {
        clSyms.push([v, 0, 0]); clFreq[v]++;
        let left = run - 1;
        while (left >= 3) { const take = Math.min(left, 6); clSyms.push([16, take - 3, 2]); clFreq[16]++; left -= take; }
        while (left > 0) { clSyms.push([v, 0, 0]); clFreq[v]++; left--; }
      }
      k += run;
    }
  }
  const clLens = buildLengths(clFreq, 7, true); // the cl alphabet must be complete
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 4;
  for (let k = 18; k >= 4; k--) if (clLens[CL_ORDER[k]] > 0) { hclen = k + 1; break; }
  // Exact bit costs.
  let dynDataBits = 0;
  for (let s = 0; s < 288; s++) dynDataBits += litFreq[s] * litLens[s];
  for (let s = 0; s < 30; s++) dynDataBits += distFreq[s] * distLens[s];
  let dynTableBits = 14 + 3 * hclen;
  for (const [s, , eb] of clSyms) dynTableBits += clLens[s] + eb;
  let fixedBits = 0;
  for (let s = 0; s < 288; s++) fixedBits += litFreq[s] * FIXED_LIT_LEN[s];
  for (let s = 0; s < 30; s++) fixedBits += distFreq[s] * 5;
  const useDynamic = (3 + dynTableBits + dynDataBits) < (3 + fixedBits);
  const litCode = canonicalCodes(useDynamic ? litLens : FIXED_LIT_LEN);
  const distCode = canonicalCodes(useDynamic ? distLens : FIXED_DIST_LEN);
  bw.put(isFinal ? 1 : 0, 1);
  if (useDynamic) {
    bw.put(2, 2); // BTYPE = 10
    bw.put(hlit - 257, 5);
    bw.put(hdist - 1, 5);
    bw.put(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) bw.put(clLens[CL_ORDER[k]], 3);
    const clCode = canonicalCodes(clLens);
    for (const [s, ev, eb] of clSyms) {
      bw.putReversed(clCode.codes[s], clCode.lens[s]);
      if (eb > 0) bw.put(ev, eb);
    }
  } else {
    bw.put(1, 2); // BTYPE = 01
  }
  for (let k = 0; k < syms.length; k++) {
    const s = syms[k];
    bw.putReversed(litCode.codes[s], litCode.lens[s]);
    if (dists[k] > 0) {
      const ls = s - 257;
      bw.put(lens[k] - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = distSym(dists[k]);
      bw.putReversed(distCode.codes[ds], distCode.lens[ds]);
      bw.put(dists[k] - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.putReversed(litCode.codes[256], litCode.lens[256]);
}

// ---------------------------------------------------------------- driver
// Optimal-parse DEFLATE of `data` (Uint8Array), returned as a whole zlib stream.
function deflateOptimal(data) {
  const n = data.length;
  const padded = new Uint8Array(n + 8);
  padded.set(data, 0);
  const u32 = new Uint32Array(padded.buffer, 0, (n + 8) >> 2);
  const bw = new BitWriter(n >> 2);
  const nb = Math.max(1, Math.ceil(n / BLOCK_SIZE));
  // Greedy pass (whole instance, chains persist across blocks) -> per-block frequencies.
  const blockFreq = [];
  {
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(n).fill(-1);
    for (let b = 0; b < nb; b++) {
      const start = b * BLOCK_SIZE, end = Math.min(n, start + BLOCK_SIZE);
      const litFreq = new Uint32Array(288);
      const distFreq = new Uint32Array(30);
      greedyBlock(padded, u32, start, end, n, head, prev, litFreq, distFreq);
      litFreq[256]++;
      blockFreq.push({ litFreq, distFreq });
    }
  }
  // DP pass (chains rebuilt, persisting across blocks) -> emit each block.
  {
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(n).fill(-1);
    for (let b = 0; b < nb; b++) {
      const start = b * BLOCK_SIZE, end = Math.min(n, start + BLOCK_SIZE);
      const { litFreq, distFreq } = blockFreq[b];
      const hasMatch = distFreq.some((x) => x > 0);
      let litLen, distLen;
      if (hasMatch) {
        // Pseudocounts: every symbol that COULD be emitted must cost something in
        // the model. Without them a symbol absent from the greedy parse costs 0,
        // and the DP "cheats" by emitting it as a free literal instead of a match.
        const lf = Uint32Array.from(litFreq);
        for (let s = 0; s < 288; s++) lf[s]++;
        const df = Uint32Array.from(distFreq);
        for (let s = 0; s < 30; s++) df[s]++;
        litLen = buildLengths(lf, 15);
        distLen = buildLengths(df, 15);
      } else {
        litLen = FIXED_LIT_LEN;
        distLen = FIXED_DIST_LEN;
      }
      // Per-length / per-distance bit costs under the cost model (extras included).
      const lenCost = new Float64Array(259);
      for (let len = 3; len <= 258; len++) {
        const ls = lenSym(len);
        lenCost[len] = litLen[257 + ls] + LEN_EXTRA[ls];
      }
      const distCost = new Float64Array(32769);
      for (let dd = 1; dd <= 32768; dd++) {
        const ds = distSym(dd);
        distCost[dd] = distLen[ds] + DIST_EXTRA[ds];
      }
      const { syms, dists, lens } = dpBlock(padded, u32, start, end, n, head, prev, litLen, distLen, lenCost, distCost);
      emitBlock(bw, syms, dists, lens, b === nb - 1);
    }
  }
  bw.align();
  const deflated = bw.bytes();
  const out = new Uint8Array(2 + deflated.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(deflated, 2);
  new DataView(out.buffer).setUint32(2 + deflated.length, adler32(data));
  return out;
}

// One instance: decode, screen forms, optimal-parse the winner, assemble the PNG.
function squeezeOne(bytes) {
  const rgba = decodePng(bytes);
  const best = screen(rgba);
  const zlib = deflateOptimal(best.data);
  const chunks = [['IHDR', ihdrOf(WIDTH, HEIGHT, best.form.colourType)]];
  if (best.form.plte !== null) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns !== null) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', zlib]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const bytes = readFileSync(join(INPUT_DIR, id, 'image.png'));
  const png = squeezeOne(new Uint8Array(bytes));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
