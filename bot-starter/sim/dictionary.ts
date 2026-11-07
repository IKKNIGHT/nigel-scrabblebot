// The server's dictionary (spacetimedb/src/dictionary.ts, MIT, Clockwork
// Labs), loading the same wordlist.txt from disk instead of the bundler.
// The sim uses it to validate words and to play for sim bots, so both match
// the server exactly.

import * as fs from "node:fs";
import { defaultWordlistPath } from "../src/words.js";

let LEX_WORDS: string[] | undefined;
let WORDS_BY_LENGTH: string[] | undefined;

export function lexWords(): string[] {
  LEX_WORDS ??= fs
    .readFileSync(process.env.WORDLIST ?? defaultWordlistPath(), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return LEX_WORDS;
}

function wordsByLength(): string[] {
  WORDS_BY_LENGTH ??= [...lexWords()].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return WORDS_BY_LENGTH;
}

export function isValidWord(word: string): boolean {
  const target = word.toUpperCase();
  if (target.length < 2) return false;
  const words = lexWords();
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const w = words[mid]!;
    if (w < target) {
      lo = mid + 1;
    } else if (w === target) {
      return true;
    } else {
      hi = mid;
    }
  }
  return false;
}

const A = "A".charCodeAt(0);

// wordsByLength() compiled to masks and counts. Same order, so the first
// fit is the same word the server picks.
interface Index {
  words: string[];
  len: Uint8Array;
  mask: Int32Array;
  counts: Uint8Array; // n × 26
  firstAtMost: Int32Array; // firstAtMost[L] = first index with length <= L
}
let INDEX: Index | undefined;

function index(): Index {
  if (INDEX) return INDEX;
  const words = wordsByLength();
  const n = words.length;
  const len = new Uint8Array(n);
  const mask = new Int32Array(n);
  const counts = new Uint8Array(n * 26);
  for (let k = 0; k < n; k++) {
    const w = words[k]!;
    len[k] = w.length;
    let m = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - A;
      counts[k * 26 + c]++;
      m |= 1 << c;
    }
    mask[k] = m;
  }
  const maxLen = n ? len[0]! : 0;
  const firstAtMost = new Int32Array(maxLen + 2).fill(n);
  for (let k = n - 1; k >= 0; k--) firstAtMost[len[k]!] = k;
  for (let L = 1; L <= maxLen + 1; L++) {
    firstAtMost[L] = Math.min(firstAtMost[L]!, firstAtMost[L - 1]!);
  }
  INDEX = { words, len, mask, counts, firstAtMost };
  return INDEX;
}

// Find the longest word in the dictionary that can be spelled from `rack`.
// Returns undefined if no word of `minLen` or longer can be made.
// Same result as the server's findBestPlayable.
export function findBestPlayable(
  rack: Map<string, number>,
  minLen: number,
): string | undefined {
  const rackCounts = new Uint8Array(26);
  let total = 0;
  let rm = 0;
  for (const [c, n] of rack) {
    if (n > 0 && /^[A-Z]$/.test(c)) {
      const i = c.charCodeAt(0) - A;
      rackCounts[i] = Math.min(255, rackCounts[i]! + n);
      rm |= 1 << i;
      total += n;
    }
  }
  if (total < minLen) return undefined;
  const ix = index();
  const from = ix.firstAtMost[Math.min(total, ix.firstAtMost.length - 1)]!;
  for (let k = from; k < ix.words.length; k++) {
    if (ix.len[k]! < minLen) break;
    if ((ix.mask[k]! & ~rm) !== 0) continue;
    const o = k * 26;
    let ok = true;
    for (let i = 0; i < 26; i++) {
      if (ix.counts[o + i]! > rackCounts[i]!) {
        ok = false;
        break;
      }
    }
    if (ok) return ix.words[k];
  }
  return undefined;
}
