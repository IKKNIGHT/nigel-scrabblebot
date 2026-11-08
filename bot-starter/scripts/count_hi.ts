// How often Nigel cashes a J/Q/X/Z in a short word in the sim, and whether
// a candidate params file changes that.  npx tsx scripts/count_hi.ts results/hi7.json 40
import * as fs from "node:fs";
import { runMatch } from "../sim/engine.js";
import { agentFor, nigelAgent } from "../train/agents.js";

async function main() {
  const file = process.argv[2] ?? "params.json";
  const matches = Number(process.argv[3] ?? 40);
  const opp = await Promise.all(["live@Bron", "live@gas", "live@Lbender", "live@GodOfThudner", "live@aipom"].map(agentFor));
  for (const [label, pf] of [["base", "params.json"], ["cand", file]]) {
    const me = nigelAgent("me", JSON.parse(fs.readFileSync(pf!, "utf8")));
    let hiShort = 0, hiLong = 0, hiLeft = 0, score = 0, place = 0;
    for (let m = 0; m < matches; m++) {
      const r = runMatch([me, ...opp], { seed: 900 + m });
      const mine = r.words.filter((w) => w.bot === "s0");
      for (const w of mine) if (/[JQXZ]/.test(w.word)) (w.word.length >= 7 ? hiLong++ : hiShort++);
      const won = r.results.filter((x) => x.winner === "s0" && /[JQXZ]/.test(x.letter)).length;
      hiLeft += won - mine.reduce((s, w) => s + (w.word.match(/[JQXZ]/g)?.length ?? 0), 0);
      score += r.seats[0]!.score;
      place += r.seats[0]!.place;
    }
    console.log(`${label}: hi in short words ${(hiShort / matches).toFixed(2)}/match, in 7+ ${(hiLong / matches).toFixed(2)}, unplayed ${(hiLeft / matches).toFixed(2)}, score ${(score / matches).toFixed(1)}, place ${(place / matches).toFixed(2)}`);
  }
}
main();
