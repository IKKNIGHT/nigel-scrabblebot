// Opponent pool. Names on the --table flag resolve here.
//
//   cheapo / valor / brutus   server sim bots (Cheapskate / ValueBidder /
//                             Aggressive), rules from game.ts — exact
//   starter                   the official bot-starter strategy — exact
//   nigel, nigel@<params>     our bot, optionally with a saved params file
//   gaucho, afterword,        public forks, loaded from FORKS_DIR (default
//   micah, taylor             ../../forks). Test-only: never imported by the
//                             live bot, never shipped.
//   bron, lucent, maverick    proxies of top live bots (train/agents.ts),
//                             fitted from public history — approximate

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { idx } from "../../src/rules.js";
import { createStrategy, type PriceTable } from "../../src/strategy.js";
import type { BidCtx, WordCtx } from "../../src/view.js";
import { loadDict, defaultWordlistPath } from "../../src/words.js";
import type { Agent } from "../engine.js";
import { findBestPlayable, lexWords } from "../dictionary.js";
import * as starter from "./starter-strategy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = path.resolve(HERE, "..", "..");
const FORKS_DIR = process.env.FORKS_DIR ?? path.resolve(BOT_DIR, "..", "..", "forks");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

const seatOf = (id: string) => Number(id.slice(1));

// Fork strategies return one word at a time; keep asking until they stop.
function wordLoop(
  ctx: WordCtx,
  pick: (rack: Map<string, number>, balance: number) => string | null,
): string[] {
  const rack = new Map(ctx.rackMap);
  let balance = ctx.balance;
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const w = pick(rack, balance);
    if (!w) break;
    const need = new Map<string, number>();
    for (const c of w.toUpperCase()) need.set(c, (need.get(c) ?? 0) + 1);
    if ([...need].some(([c, n]) => (rack.get(c) ?? 0) < n)) break;
    for (const [c, n] of need) rack.set(c, rack.get(c)! - n);
    for (const [c, n] of [...rack]) if (n <= 0) rack.delete(c);
    out.push(w.toUpperCase());
  }
  return out;
}

async function importFork(rel: string): Promise<any> {
  const file = path.join(FORKS_DIR, rel);
  if (!fs.existsSync(file)) throw new Error(`fork not found: ${file} (set FORKS_DIR)`);
  return import(pathToFileURL(file).href);
}

// `nigel@path/params.json` or `nigel@{"mu0":0.3}` (inline, merged over
// params.json); plain `nigel` uses params.json.
function nigel(name: string, arg?: string): Agent {
  const base = readJson<object>(path.join(BOT_DIR, "params.json")) ?? {};
  const params = !arg
    ? base
    : arg.startsWith("{")
      ? { ...base, ...JSON.parse(arg) }
      : (readJson<object>(path.resolve(arg)) ?? base);
  // A params file may name its own price tables ("priceTable", "topTable").
  const p = params as { priceTable?: string; topTable?: string };
  const prices = readJson<PriceTable>(path.join(BOT_DIR, p.priceTable ?? "data/price_table.json"));
  const tops = readJson<PriceTable>(path.join(BOT_DIR, p.topTable ?? "data/top_table.json"));
  const s = createStrategy(loadDict(), params, prices, tops);
  return { name, decideBid: s.decideBid, chooseWords: s.chooseWords };
}

// The starter's chooseWord returns the first fit in a length-sorted
// wordlist: the same word as the server's findBestPlayable(rack, 2), which
// is much faster here.
function starterAgent(): Agent {
  return {
    name: "starter",
    decideBid: (ctx) => starter.decideBid({ letter: ctx.letter, myBalance: ctx.balance, myRack: ctx.rackMap }),
    chooseWords: (ctx) => {
      const w = findBestPlayable(ctx.rackMap, 2);
      return w ? [w] : [];
    },
  };
}

async function gaucho(): Promise<Agent> {
  const root = "JoaquinGiorgis_scrabblebot-gaucho/bot-starter";
  const dictMod = await importFork(`${root}/src/core/dict.ts`);
  const policy = await importFork(`${root}/src/core/policy.ts`);
  const d = dictMod.loadDict(defaultWordlistPath());
  const dir = path.join(FORKS_DIR, root, "params");
  const params = (fp: boolean) => ({
    ...policy.DEFAULT_PARAMS,
    ...(readJson(path.join(dir, fp ? "firstprice.json" : "vickrey.json")) ?? {}),
  });
  const pv = params(false);
  const pf = params(true);
  const market = readJson<number[][]>(path.join(dir, "market-paid.json"));
  const marketTop = readJson<number[][]>(path.join(dir, "market-top.json"));
  const view = (ctx: WordCtx) => ({
    rack: Int32Array.from(ctx.rack),
    balance: ctx.balance,
    unseen: Int32Array.from(ctx.unseen),
    auctionsLeft: ctx.auctionsLeft,
    firstPrice: ctx.auctionType === "FirstPrice",
    won: ctx.results.filter((r) => r.winner === ctx.me).length,
    round: ctx.round,
    market,
    marketTop,
  });
  const P = (ctx: WordCtx) => (ctx.auctionType === "FirstPrice" ? pf : pv);
  return {
    name: "gaucho",
    decideBid: (ctx) => policy.decideBid(d, P(ctx), view(ctx), idx(ctx.letter)),
    chooseWords: (ctx) => policy.chooseWords(d, P(ctx), view(ctx)),
  };
}

async function afterword(): Promise<Agent> {
  const mod = await importFork("Jose-Gael-Cruz-Lopez_afterword-scrabblebot/bot-starter/src/strategy.ts");
  const dictionary = lexWords();
  const s = mod.createStrategy(dictionary);
  let matchId = "0";
  const base = (ctx: WordCtx) => ({
    myBalance: ctx.balance,
    dictionary,
    matchId,
    seat: seatOf(ctx.me),
    roundsRemaining: ctx.auctionsLeft + 1,
    round: ctx.round,
    auctionType: ctx.auctionType,
    letter: ctx.letter ?? undefined,
    players: [
      { seat: seatOf(ctx.me), balance: ctx.balance, score: ctx.score },
      ...ctx.opponents.map((o) => ({ seat: seatOf(o.bot), balance: o.balance, score: o.score })),
    ].sort((a, b) => a.seat - b.seat),
    history: ctx.results.map((r) => ({
      round: r.round,
      letter: r.letter,
      winner: r.winner === undefined ? undefined : seatOf(r.winner),
      paid: r.paid,
    })),
    publicWords: ctx.words.map((w) => ({ seat: seatOf(w.bot), word: w.word, reward: w.reward })),
  });
  return {
    name: "afterword",
    newMatch: (_seat, seed) => {
      matchId = String(seed);
    },
    decideBid: (ctx) => s.decideBid({ ...base(ctx), myRack: ctx.rackMap, letter: ctx.letter }),
    chooseWords: (ctx) =>
      wordLoop(ctx, (rack, bal) => s.chooseWord({ ...base(ctx), myRack: rack, myBalance: bal })),
  };
}

async function micah(): Promise<Agent> {
  const mod = await importFork("micahlai_scrabblebot/bot-starter/src/strategy.ts");
  const dictionary = [...lexWords()];
  mod.prepareDictionary(dictionary);
  let lastSig = "";
  let since = 0;
  return {
    name: "micah",
    newMatch: () => {
      lastSig = "";
      since = 0;
    },
    decideBid: (ctx) =>
      mod.decideBid({
        letter: ctx.letter,
        myBalance: ctx.balance,
        myRack: ctx.rackMap,
        dictionary,
        remaining: ctx.auctionsLeft,
        auctionType: ctx.auctionType,
        profile: "planner",
        aggression: 1,
        qualityMode: "off",
      }),
    chooseWords: (ctx) => {
      const sig = [...ctx.rack].join(",");
      if (sig !== lastSig) {
        lastSig = sig;
        since = ctx.auctionsLeft;
      }
      return wordLoop(ctx, (rack, bal) =>
        mod.chooseWord({
          myRack: rack,
          dictionary,
          remaining: ctx.auctionsLeft,
          myBalance: bal,
          profile: "planner",
          patience: 1,
          stalledAuctions: Math.max(0, since - ctx.auctionsLeft),
        }),
      );
    },
  };
}

async function taylor(): Promise<Agent> {
  const root = "Phaslyr_scrabblebot/bot-starter/src";
  const strat = await importFork(`${root}/strategy.ts`);
  const mod = await importFork(`${root}/taylor.ts`);
  const dictionary = lexWords();
  strat.prepareDictionary(dictionary);
  const base = (ctx: WordCtx) => ({
    dictionary,
    myBalance: ctx.balance,
    myScore: ctx.score,
    progress: Math.min(1, (ctx.round - 1) / Math.max(1, ctx.totalRounds - 1)),
    remainingTiles: ctx.auctionsLeft,
    auctionType: ctx.auctionType,
    auctionLetter: ctx.letter ?? undefined,
  });
  return {
    name: "taylor",
    decideBid: (ctx: BidCtx) => mod.decideTaylorBid({ ...base(ctx), myRack: ctx.rackMap, letter: ctx.letter }),
    chooseWords: (ctx) =>
      wordLoop(ctx, (rack, bal) => mod.chooseTaylorWord({ ...base(ctx), myRack: rack, myBalance: bal })),
  };
}

export async function makeAgent(spec: string): Promise<Agent> {
  const at = spec.indexOf("@");
  const name = at < 0 ? spec : spec.slice(0, at);
  const arg = at < 0 ? undefined : spec.slice(at + 1);
  switch (name) {
    case "cheapo":
      return { name: spec, sim: "Cheapskate" };
    case "valor":
      return { name: spec, sim: "ValueBidder" };
    case "brutus":
      return { name: spec, sim: "Aggressive" };
    case "starter":
      return starterAgent();
    case "nigel":
      return nigel(spec, arg);
    case "gaucho":
      return gaucho();
    case "afterword":
      return afterword();
    case "micah":
      return micah();
    case "taylor":
      return taylor();
    // Proxies of top live bots, fitted from public history (train/). Loaded
    // lazily: train/agents.ts imports this module.
    case "bron":
    case "lucent":
    case "maverick": {
      const { proxyAgent } = await import("../../train/agents.js");
      return proxyAgent(spec, { bron: "Bron", lucent: "LUCENT", maverick: "maverick-bot" }[name]);
    }
    // live@<BotName>: proxy of any live bot with a profile in data/profiles.json.
    case "live": {
      if (!arg) throw new Error("live@<BotName> needs a bot name");
      const { proxyAgent } = await import("../../train/agents.js");
      return proxyAgent(spec, arg);
    }
    default:
      throw new Error(`unknown opponent '${spec}'`);
  }
}

