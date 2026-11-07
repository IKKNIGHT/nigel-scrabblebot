// Fit a bid profile for each top live bot from public, post-auction data:
// per letter and fifth of the match, the median of its winning bids (from
// auction_top_bid_archive), plus the spread of log bids and how many
// auctions it wins per match. Losing bids are never public, so the medians
// lean high; train/agents.ts scales them so the proxy wins as often as the
// real bot. Writes data/profiles.json.
//   npx tsx train/fit_profiles.ts [Bron,LUCENT,maverick-bot]

import * as fs from "node:fs";
import { LETTERS } from "../src/rules.js";
import { PHASES } from "../src/strategy.js";
import { readTable } from "../scripts/build_price_table.js";

const opt = (v: unknown) => (Array.isArray(v) ? (v[0] === 0 ? v[1] : undefined) : v);

export interface Profile {
  bid: Record<string, number[]>; // letter -> per-phase median winning bid
  logSd: number;
  winsPerMatch: number;
  scorePerMatch: number;
  matches: number;
}

function main() {
  const names = (process.argv[2] ?? "Bron,LUCENT,maverick-bot").split(",");
  const bots = new Map(readTable("data/bot.json").map((b) => [String(b.name), String(b.id)]));
  const top = new Map(readTable("data/auction_top_bid_archive.json").map((t) => [String(t.auction_id), Number(t.top_bid)]));
  const results = readTable("data/auction_result.json");
  const parts = readTable("data/match_participant.json");
  const byMatch = new Map<string, Record<string, unknown>[]>();
  for (const a of results) {
    const m = String(a.match_id);
    if (!byMatch.has(m)) byMatch.set(m, []);
    byMatch.get(m)!.push(a);
  }
  for (const as of byMatch.values()) as.sort((a, b) => Number(a.auction_id) - Number(b.auction_id));

  const out: Record<string, Profile> = {};
  for (const name of names) {
    const id = bots.get(name);
    if (!id) {
      console.warn(`no bot named ${name}`);
      continue;
    }
    const mine = parts.filter((p) => String(p.bot_id) === id);
    const ms = new Set(mine.map((p) => String(p.match_id)));
    const bids = new Map<string, number[][]>(LETTERS.split("").map((c) => [c, Array.from({ length: PHASES }, () => [])]));
    const logs: number[] = [];
    let wins = 0;
    for (const m of ms) {
      const as = byMatch.get(m);
      if (!as || as.length < 60) continue;
      as.forEach((a, i) => {
        if (String(opt(a.winner_bot_id)) !== id) return;
        const b = top.get(String(a.auction_id));
        if (b === undefined) return;
        wins++;
        const phase = Math.min(PHASES - 1, Math.floor((i * PHASES) / as.length));
        bids.get(String(a.letter))![phase]!.push(b);
        logs.push(Math.log(Math.max(1, b)));
      });
    }
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
    const bid: Record<string, number[]> = {};
    for (const [c, ph] of bids) {
      const all = ph.flat();
      bid[c] = ph.map((xs) => median(xs.length >= 5 ? xs : all));
    }
    // Spread within a letter-phase cell, pooled.
    let ss = 0;
    let n = 0;
    for (const ph of bids.values()) {
      for (const xs of ph) {
        if (xs.length < 5) continue;
        const ls = xs.map((x) => Math.log(Math.max(1, x)));
        const mu = ls.reduce((a, b) => a + b, 0) / ls.length;
        for (const l of ls) ss += (l - mu) ** 2;
        n += ls.length;
      }
    }
    out[name] = {
      bid,
      logSd: n > 1 ? Math.sqrt(ss / n) : 0.3,
      winsPerMatch: wins / Math.max(1, ms.size),
      scorePerMatch: mine.reduce((a, p) => a + Number(p.score), 0) / Math.max(1, mine.length),
      matches: ms.size,
    };
    console.log(
      `${name}: ${ms.size} matches, ${out[name].winsPerMatch.toFixed(1)} wins/match, ${out[name].scorePerMatch.toFixed(0)} pts/match, log sd ${out[name].logSd.toFixed(2)}`,
    );
  }
  fs.writeFileSync("data/profiles.json", JSON.stringify(out));
}

main();
