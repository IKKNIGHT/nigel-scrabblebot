// Print Nigel's letter values and bids for a few racks: a quick sanity check.
import * as fs from "node:fs";
import { createStrategy } from "../src/strategy.js";
import { buildCtx, type BidCtx } from "../src/view.js";
const rd = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const s = createStrategy(undefined, rd("params.json") ?? {}, rd("data/price_table.json"), rd("data/top_table.json"));
const rack = (l: string) => { const m = new Map<string, number>(); for (const c of l) m.set(c, (m.get(c) ?? 0) + 1); return m; };
const ctxFor = (r: string, round: number, L: string | null, bal = 100) =>
  buildCtx({ me: "s0", round, auctionsLeft: 68 - round, auctionType: "Vickrey", letter: L, rack: rack(r), players: [{ bot: "s0", balance: bal, score: 0 }], results: [], words: [], startingRack: 5 });
for (const [r, round] of [["EATRN", 5], ["EATRNI", 20], ["QOZBV", 10], ["AEIOE", 10], ["RETAIN", 60], ["SATIRE", 67]] as const) {
  const row: string[] = [];
  const t0 = performance.now();
  for (const L of "AESTRDQXZ") {
    const ctx = ctxFor(r, round, L) as BidCtx;
    row.push(`${L}:${s.letterValue(ctx).toFixed(0)}/${s.decideBid(ctx)}`);
  }
  const ms = (performance.now() - t0) / 9;
  console.log(r.padEnd(7), String(round).padEnd(3), row.join(" "), `| ${ms.toFixed(1)}ms/bid | words:`, s.chooseWords(ctxFor(r, round, null)).join(","));
}
