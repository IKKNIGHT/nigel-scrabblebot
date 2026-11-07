// Checks for the sim. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { findBestPlayable, lexWords } from "./dictionary.js";
import { runMatch, Rng, type Agent } from "./engine.js";

// The server's original scan, kept as the reference.
function referenceBestPlayable(rack: Map<string, number>, minLen: number): string | undefined {
  const counts = new Array<number>(26).fill(0);
  let total = 0;
  for (const [c, n] of rack) {
    counts[c.charCodeAt(0) - 65] += n;
    total += n;
  }
  if (total < minLen) return undefined;
  const words = [...lexWords()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const need = new Array<number>(26);
  for (const w of words) {
    if (w.length < minLen) break;
    if (w.length > total) continue;
    need.fill(0);
    for (let i = 0; i < w.length; i++) need[w.charCodeAt(i) - 65]!++;
    if (need.every((n, i) => n <= counts[i]!)) return w;
  }
  return undefined;
}

test("indexed findBestPlayable matches the server's scan", () => {
  const rng = new Rng(99);
  const bag = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";
  for (let t = 0; t < 60; t++) {
    const rack = new Map<string, number>();
    const n = rng.int(0, 14);
    for (let i = 0; i < n; i++) {
      const c = bag[rng.int(0, bag.length - 1)]!;
      rack.set(c, (rack.get(c) ?? 0) + 1);
    }
    const minLen = t % 2 ? 3 : 2;
    assert.equal(findBestPlayable(rack, minLen), referenceBestPlayable(rack, minLen), [...rack].join());
  }
});

const sims: Agent[] = [
  { name: "a", sim: "Cheapskate" },
  { name: "b", sim: "ValueBidder" },
  { name: "c", sim: "Aggressive" },
  { name: "d", sim: "Cheapskate" },
  { name: "e", sim: "ValueBidder" },
  { name: "f", sim: "Aggressive" },
];

test("a match runs 68 auctions and replays exactly from its seed", () => {
  const r1 = runMatch(sims, { seed: 5 });
  const r2 = runMatch(sims, { seed: 5 });
  assert.equal(r1.results.length, 68);
  assert.deepEqual(r1.seats.map((s) => s.score), r2.seats.map((s) => s.score));
});

test("the tile sequence depends only on the seed", () => {
  const greedy: Agent = { name: "g", decideBid: (c) => c.balance };
  const r1 = runMatch(sims, { seed: 11 });
  const r2 = runMatch([greedy, ...sims.slice(1)], { seed: 11 });
  assert.deepEqual(r1.results.map((r) => r.letter), r2.results.map((r) => r.letter));
});
