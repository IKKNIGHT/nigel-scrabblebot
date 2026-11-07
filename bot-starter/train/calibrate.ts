// Check proxies against the live bots they imitate: tiles won, price paid
// and points per match on a table of proxies only (live tables are six real
// bots), next to the fitted live numbers in data/profiles.json.
//   npx tsx train/calibrate.ts --matches 100 [--table "live@Bron,live@StickBot,…"]
// PROXY_SCALES and PROXY_BRAIN (see train/agents.ts) change the proxies.

import * as fs from "node:fs";
import { runMatch, type Agent } from "../sim/engine.js";
import { agentFor } from "./agents.js";
import type { Profile } from "./fit_profiles.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}

async function main() {
  const matches = Number(arg("matches", "100"));
  const table = arg(
    "table",
    "live@RackMaw,live@GodOfThudner,live@Bron,live@StickBot,live@exzell,live@Tow57-Auctioneer",
  ).split(",");
  const profiles = JSON.parse(fs.readFileSync("data/profiles.json", "utf8")) as Record<string, Profile>;
  const agents: Agent[] = [];
  for (const s of table) agents.push(await agentFor(s));
  const st = table.map(() => ({ tiles: 0, paid: 0, score: 0, place: 0 }));
  for (let m = 0; m < matches; m++) {
    // Rotate seats so no proxy keeps a seat advantage.
    const order = table.map((_, i) => (i + m) % table.length);
    const r = runMatch(order.map((i) => agents[i]!), { seed: 7000 + m });
    r.seats.forEach((s, k) => {
      const i = order[k]!;
      st[i]!.score += s.score;
      st[i]!.place += s.place;
    });
    for (const x of r.results) {
      const k = x.winner === undefined ? -1 : Number(x.winner.slice(1));
      if (k < 0 || Number.isNaN(k)) continue;
      const i = order[k]!;
      st[i]!.tiles++;
      st[i]!.paid += x.paid;
    }
  }
  console.log("bot".padEnd(24), "tiles sim/live", "  paid/tile", "  pts sim/live", "  place");
  table.forEach((s, i) => {
    const p = profiles[s.split("@")[1] ?? ""];
    const x = st[i]!;
    console.log(
      s.padEnd(24),
      `${(x.tiles / matches).toFixed(1)} / ${p ? p.winsPerMatch.toFixed(1) : "?"}`.padEnd(16),
      (x.paid / Math.max(1, x.tiles)).toFixed(1).padEnd(11),
      `${(x.score / matches).toFixed(0)} / ${p ? p.scorePerMatch.toFixed(0) : "?"}`.padEnd(15),
      (x.place / matches).toFixed(2),
    );
  });
}

main();
