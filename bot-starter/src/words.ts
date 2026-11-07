// Word finder. The wordlist is compiled once into typed arrays: a 26-bit
// letter mask, per-letter counts and the reward for every word, sorted by
// reward descending, so every search can stop at the first fit. The scan
// follows the server's `findBestPlayable` (spacetimedb/src/dictionary.ts),
// with the mask check in front of the count check.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Rack, VALUE, wordReward } from "./rules.js";

export interface Dict {
  n: number;
  words: string[];
  counts: Uint8Array; // n × 26
  len: Uint8Array;
  base: Uint16Array; // letter sum
  reward: Uint16Array;
  mask: Int32Array;
  // Fraction of 7+ letter words that contain each letter.
  pLong: Float64Array;
}

let CACHED: Dict | undefined;

export function defaultWordlistPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "spacetimedb", "wordlist.txt");
}

export function loadDict(file = process.env.WORDLIST ?? defaultWordlistPath()): Dict {
  if (CACHED) return CACHED;
  const words = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2 && /^[A-Z]+$/.test(l));
  const rewards = words.map(wordReward);
  const order = words.map((_, i) => i);
  order.sort((a, b) => rewards[b]! - rewards[a]! || words[b]!.length - words[a]!.length);

  const n = words.length;
  const d: Dict = {
    n,
    words: new Array<string>(n),
    counts: new Uint8Array(n * 26),
    len: new Uint8Array(n),
    base: new Uint16Array(n),
    reward: new Uint16Array(n),
    mask: new Int32Array(n),
    pLong: new Float64Array(26),
  };
  let longWords = 0;
  for (let k = 0; k < n; k++) {
    const w = words[order[k]!]!;
    d.words[k] = w;
    d.len[k] = w.length;
    d.reward[k] = rewards[order[k]!]!;
    let m = 0;
    let base = 0;
    for (let j = 0; j < w.length; j++) {
      const c = w.charCodeAt(j) - 65;
      d.counts[k * 26 + c]++;
      m |= 1 << c;
      base += VALUE[c]!;
    }
    d.mask[k] = m;
    d.base[k] = base;
    if (w.length >= 7) {
      longWords++;
      for (let c = 0; c < 26; c++) if (m & (1 << c)) d.pLong[c]++;
    }
  }
  for (let c = 0; c < 26; c++) d.pLong[c] /= Math.max(1, longWords);
  CACHED = d;
  return d;
}

export function rackMask(r: Rack): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (r[i]) m |= 1 << i;
  return m;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function rackBase(r: Rack): number {
  let s = 0;
  for (let i = 0; i < 26; i++) s += r[i]! * VALUE[i]!;
  return s;
}

export function fits(d: Dict, k: number, r: Rack, rm: number): boolean {
  if ((d.mask[k]! & ~rm) !== 0) return false;
  const o = k * 26;
  for (let i = 0; i < 26; i++) if (d.counts[o + i]! > r[i]!) return false;
  return true;
}

// Words that fit the rack, best reward first, at most `limit`.
export function playable(d: Dict, r: Rack, limit = 500, minLen = 2): number[] {
  const out: number[] = [];
  const rm = rackMask(r);
  let total = 0;
  for (let i = 0; i < 26; i++) total += r[i]!;
  for (let k = 0; k < d.n && out.length < limit; k++) {
    const L = d.len[k]!;
    if (L > total || L < minLen) continue;
    if (fits(d, k, r, rm)) out.push(k);
  }
  return out;
}

// Highest-reward word that fits, or -1.
export function bestWord(d: Dict, r: Rack, minLen = 2): number {
  const p = playable(d, r, 1, minLen);
  return p.length ? p[0]! : -1;
}

export function subtract(d: Dict, r: Rack, k: number): Rack {
  const out = new Uint8Array(r);
  const o = k * 26;
  for (let i = 0; i < 26; i++) out[i] -= d.counts[o + i]!;
  return out;
}

export interface Split {
  words: string[];
  score: number;
}

// Best set of disjoint words from the rack: depth-first over the top
// candidates, memoised on the remaining rack, pruned by
// current + 3 × remaining letter sum, with a greedy fallback when the time
// cap runs out.
export function bestSplit(d: Dict, r: Rack, timeMs = 50, maxCand = 500): Split {
  const cands = playable(d, r, maxCand);
  if (cands.length === 0) return { words: [], score: 0 };
  const deadline = performance.now() + timeMs;
  const memo = new Map<string, { score: number; first: number }>();
  let timedOut = false;
  let nodes = 0;

  const key = (x: Rack) => String.fromCharCode(...x);

  function solve(x: Rack, from: number): number {
    const kx = key(x) + ":" + from;
    const hit = memo.get(kx);
    if (hit) return hit.score;
    let best = 0;
    let first = -1;
    const xm = rackMask(x);
    const xb = rackBase(x);
    for (let c = from; c < cands.length; c++) {
      const k = cands[c]!;
      // A word's reward is at most 3× its letters, so this candidate and
      // everything after it can't beat `best` once the bound falls short.
      if (d.reward[k]! + 3 * (xb - d.base[k]!) <= best) continue;
      if (!fits(d, k, x, xm)) continue;
      if ((++nodes & 255) === 0 && performance.now() > deadline) {
        timedOut = true;
        break;
      }
      const s = d.reward[k]! + solve(subtract(d, x, k), c);
      if (s > best) {
        best = s;
        first = k;
      }
      if (timedOut) break;
    }
    memo.set(kx, { score: best, first });
    return best;
  }

  solve(r, 0);
  // Walk the memo for the chosen words; on a timeout fill in greedily.
  const words: string[] = [];
  let x: Rack = r;
  let from = 0;
  let score = 0;
  for (;;) {
    const hit = memo.get(key(x) + ":" + from);
    let k = hit?.first ?? -1;
    if (k < 0 && (timedOut || !hit)) k = bestWord(d, x);
    if (k < 0) break;
    words.push(d.words[k]!);
    score += d.reward[k]!;
    x = subtract(d, x, k);
    const c = cands.indexOf(k);
    from = c >= 0 ? c : from;
  }
  return { words, score };
}

// Best reachable target word given what is still to come. Every word that
// misses at most `maxMissing` tiles is worth its reward times the chance of
// collecting the missing tiles, minus what they are expected to cost.
// `pGet[i * 3 + k - 1]` is the chance of collecting k more of letter i; the
// caller derives it from the tracked bag and the time left.
export interface PotentialOpts {
  pGet: Float64Array; // 26 × 3
  cost: Float64Array; // expected coins (in score units) per missing tile
  maxMissing: number;
  minLen: number;
}

export interface Target {
  value: number;
  word: number; // dictionary index, -1 if none
}

export function bestTarget(d: Dict, r: Rack, o: PotentialOpts): Target {
  let total = 0;
  for (let i = 0; i < 26; i++) total += r[i]!;
  const maxMissing = o.maxMissing;
  const rm = rackMask(r);
  let best = 0;
  let word = -1;
  for (let k = 0; k < d.n; k++) {
    const rw = d.reward[k]!;
    if (rw <= best) break; // sorted by reward, and value <= reward
    const L = d.len[k]!;
    if (L < o.minLen || L > total + maxMissing) continue;
    const miss = d.mask[k]! & ~rm;
    if (miss !== 0 && popcount(miss) > maxMissing) continue;
    const off = k * 26;
    let missing = 0;
    let p = 1;
    let cost = 0;
    for (let i = 0; i < 26; i++) {
      const need = d.counts[off + i]! - r[i]!;
      if (need <= 0) continue;
      missing += need;
      if (missing > maxMissing || need > 3) {
        p = 0;
        break;
      }
      const q = o.pGet[i * 3 + need - 1]!;
      p *= q;
      cost += need * o.cost[i]! * q;
      if (p <= 0) break;
    }
    if (p <= 0) continue;
    const v = rw * p - cost;
    if (v > best) {
      best = v;
      word = k;
    }
  }
  return { value: best, word };
}

export function potential(d: Dict, r: Rack, o: PotentialOpts): number {
  return bestTarget(d, r, o).value;
}
