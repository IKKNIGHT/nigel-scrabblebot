// Checks for the word finder, match view and strategy. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { rackFromMap, wordReward } from "./rules.js";
import { createStrategy } from "./strategy.js";
import { buildCtx, type BidCtx, type MatchRecords } from "./view.js";
import { bestSplit, bestWord, loadDict } from "./words.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const dict = loadDict();

const records = (over: Partial<MatchRecords> = {}): MatchRecords => ({
  me: "s0",
  round: 10,
  auctionsLeft: 58,
  auctionType: "Vickrey",
  letter: "E",
  rack: rack("RETAIN"),
  players: [
    { bot: "s0", balance: 80, score: 0 },
    { bot: "s1", balance: 90, score: 12 },
  ],
  results: [],
  words: [],
  startingRack: 5,
  ...over,
});

test("rewards match the server's floor(letterSum × mult)", () => {
  assert.equal(wordReward("CAT"), 5);
  assert.equal(wordReward("QUIZ"), 33); // 22 × 1.5
  assert.equal(wordReward("RETAINS"), 21); // 7 × 3
});

test("bestWord finds the highest-reward fit", () => {
  const k = bestWord(dict, rackFromMap(rack("RETAINS")));
  assert.ok(k >= 0);
  assert.equal(dict.len[k], 7);
  assert.equal(bestWord(dict, rackFromMap(rack("XQZ"))), -1);
});

test("bestSplit uses disjoint letters and beats one word", () => {
  const r = rackFromMap(rack("CATDOG"));
  const s = bestSplit(dict, r);
  const used = rack(s.words.join(""));
  for (const [c, n] of used) assert.ok(n <= r[c.charCodeAt(0) - 65]!);
  assert.equal(s.score, s.words.reduce((a, w) => a + wordReward(w), 0));
  assert.ok(s.score >= dict.reward[bestWord(dict, r)]!);
});

test("buildCtx tracks the bag and rival racks", () => {
  const ctx = buildCtx(
    records({
      results: [{ round: 1, letter: "Z", winner: "s1", paid: 9 }],
      words: [{ bot: "s1", word: "ZA", reward: 11 }],
    }),
  );
  assert.equal(ctx.unseen[25], 0); // the only Z was auctioned
  const s1 = ctx.opponents[0]!;
  assert.equal(s1.known[25], 0); // won then played
  assert.equal(s1.hidden, 4); // the A came from its dealt tiles
});

test("strategy bids within balance, 0 on the last auction", () => {
  const s = createStrategy(dict);
  const ctx = buildCtx(records()) as BidCtx;
  const bid = s.decideBid(ctx);
  assert.ok(bid >= 0 && bid <= ctx.balance);
  const last = buildCtx(records({ round: 68, auctionsLeft: 0 })) as BidCtx;
  assert.equal(s.decideBid(last), 0);
});

test("strategy plays 7+ letter words and empties the rack at the end", () => {
  const s = createStrategy(dict);
  const seven = s.chooseWords(buildCtx(records({ rack: rack("RETAINS") })));
  assert.ok(seven.some((w) => w.length >= 7));
  const end = s.chooseWords(buildCtx(records({ rack: rack("CATDOG"), round: 68, auctionsLeft: 0 })));
  // Everything worth playing goes now: at least CAT + DOG.
  assert.ok(end.reduce((a, w) => a + wordReward(w), 0) >= wordReward("CAT") + wordReward("DOG"));
});

test("a bid decision fits well within an auction", () => {
  const s = createStrategy(dict);
  const ctx = buildCtx(records({ rack: rack("BCDFGHJKLMNPRST"), letter: "A" })) as BidCtx;
  const start = performance.now();
  s.decideBid(ctx);
  s.chooseWords(ctx);
  assert.ok(performance.now() - start < 100, "a decision took 100 ms or more");
});
