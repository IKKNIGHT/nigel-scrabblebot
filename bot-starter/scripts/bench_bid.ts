// Time decideBid over a few sim matches for a params file (live limit: 100 ms).
//   npx tsx scripts/bench_bid.ts results/n2-reach4.json [matches]
import * as fs from "node:fs";
import { runMatch, type Agent } from "../sim/engine.js";
import { agentFor, nigelAgent } from "../train/agents.js";

async function main() {
  const file = process.argv[2] ?? "params.json";
  const matches = Number(process.argv[3] ?? 4);
  const me = nigelAgent("bench", JSON.parse(fs.readFileSync(file, "utf8")));
  const times: number[] = [];
  const timed: Agent = {
    ...me,
    decideBid: (ctx) => {
      const t0 = performance.now();
      const b = me.decideBid!(ctx);
      times.push(performance.now() - t0);
      return b;
    },
  };
  const opp = await Promise.all(["live@Bron", "live@gas", "live@Lbender", "gaucho", "live@RackMaw"].map(agentFor));
  for (let m = 0; m < matches; m++) runMatch([timed, ...opp], { seed: 500 + m });
  times.sort((a, b) => a - b);
  const q = (f: number) => times[Math.min(times.length - 1, Math.floor(f * times.length))]!.toFixed(1);
  console.log(`${file}: ${times.length} bids, median ${q(0.5)} ms, p99 ${q(0.99)} ms, max ${q(1)} ms`);
}

main();
