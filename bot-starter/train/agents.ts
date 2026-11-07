// Training opponents and Nigel builders.
//
//   bron / lucent / maverick   proxies of the top live bots: bid level drawn
//                              from their fitted public profile
//                              (data/profiles.json), raised on letters that fit
//                              the rack and cut on ones that don't (the real
//                              bots clearly look at their racks), with
//                              Nigel's word policy
//   nigel                      Nigel with given params
//   anything else              resolved by sim/opponents (sim bots, forks, …)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createStrategy, type Params, phaseOf, type PriceTable } from "../src/strategy.js";
import { loadDict } from "../src/words.js";
import { Rng, type Agent } from "../sim/engine.js";
import { makeAgent } from "../sim/opponents/index.js";
import type { Profile } from "./fit_profiles.js";

const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = <T>(rel: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(BOT_DIR, rel), "utf8")) as T;
  } catch {
    return null;
  }
};
export const PRICES = readJson<PriceTable>("data/price_table.json");
export const TOPS = readJson<PriceTable>("data/top_table.json");
const PROFILES = readJson<Record<string, Profile>>("data/profiles.json") ?? {};

export function nigelAgent(name: string, params: Partial<Params>): Agent {
  const s = createStrategy(loadDict(), params, PRICES, TOPS);
  return { name, decideBid: s.decideBid, chooseWords: s.chooseWords };
}

// Bid-level scales that bring each proxy close to the real bot's tiles won
// and points per match on a live-like table. PROXY_SCALES (JSON) overrides.
export const PROXY_SCALE: Record<string, number> = {
  Bron: 1,
  LUCENT: 1,
  "maverick-bot": 1,
  ...(process.env.PROXY_SCALES ? JSON.parse(process.env.PROXY_SCALES) : {}),
};

const PROXY_BRAIN: Partial<Params> = process.env.PROXY_BRAIN
  ? JSON.parse(fs.readFileSync(path.resolve(process.env.PROXY_BRAIN), "utf8"))
  : {};

export function proxyAgent(label: string, profileName: string, scale = PROXY_SCALE[profileName] ?? 1): Agent {
  const prof = PROFILES[profileName];
  if (!prof) throw new Error(`no profile for ${profileName}; run train/fit_profiles.ts`);
  // Proxies judge fit and play words like a default Nigel, or like Nigel
  // with the params in PROXY_BRAIN (a JSON file).
  const brain = createStrategy(loadDict(), PROXY_BRAIN, PRICES, TOPS);
  let rng = new Rng(1);
  // Box-Muller.
  const normal = () => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
  return {
    name: label,
    newMatch: (seat, seed) => {
      rng = new Rng((seed * 31 + seat * 977 + 7) >>> 0);
    },
    decideBid: (ctx) => {
      if (ctx.auctionsLeft <= 0) return 0;
      const base = prof.bid[ctx.letter]?.[phaseOf(ctx.round, ctx.totalRounds)] ?? 5;
      let bid = base * scale * Math.exp(prof.logSd * normal());
      const fit = brain.letterValue(ctx);
      bid = fit > 0 ? Math.max(bid, bid * 0.5 + fit) : bid * 0.5;
      return Math.max(0, Math.min(Math.floor(bid), ctx.balance));
    },
    chooseWords: brain.chooseWords,
  };
}

export async function agentFor(spec: string): Promise<Agent> {
  switch (spec) {
    case "bron":
      return proxyAgent(spec, "Bron");
    case "lucent":
      return proxyAgent(spec, "LUCENT");
    case "maverick":
      return proxyAgent(spec, "maverick-bot");
    default:
      return makeAgent(spec);
  }
}
