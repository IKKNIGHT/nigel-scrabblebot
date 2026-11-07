// Nigel's strategy. Pure: no network, no clocks beyond the search time cap.
// The live bot (index.ts) and the sim (sim/) both call it with the same
// BidCtx / WordCtx built by view.ts.
//
// Value of a rack = the best target word it can still reach (reward × chance
// of collecting the missing tiles − their expected cost), plus a share of
// the best target in what's left over. A letter is worth what it adds to
// that. Bids add face value and a pace term: coins left at the end score
// nothing, so spare balance should go into letters.

import { idx, type Rack, rackSize, VALUE } from "./rules.js";
import type { BidCtx, WordCtx } from "./view.js";
import {
  bestSplit,
  bestTarget,
  bestWord,
  type Dict,
  loadDict,
  playable,
  type PotentialOpts,
  subtract,
} from "./words.js";

export interface Params {
  // valuation
  pWin: number; // share of a letter's future arrivals we expect to win
  costW: number; // score units per coin of a missing tile's expected price
  maxMissing: number; // tiles a target may still be missing
  minLen: number; // shortest target word
  w2: number; // weight of the second target from the leftover tiles
  // bidding
  alpha: number; // × rack-value gain
  beta: number; // × face value
  idleBeta: number; // × beta when the letter adds nothing to the rack
  gamma: number; // constant
  pace: number; // × balance per remaining auction
  capBase: number; // max share of balance on one bid at round 1; opens to 1
  capPow: number;
  floorMult: number; // when behind on tiles, bid ≥ floorMult × typical top bid
  letterTarget: number; // tiles we want to win per match
  slack: number; // tiles behind pace before the floor kicks in
  qW: number; // multiplier on a Q with no U or I
  endN: number; // in the last endN auctions, value by exact best split
  allIn: number; // 1 = bid everything on the last playable tile if it scores
  denyW: number; // bid ≥ denyW × what the letter adds to a rival's best word
  shade: number; // first-price multiplier
  // words
  holdKappa: number; // play w if reward(w) + V(rest) ≥ holdKappa × V(rack)
  minPlayReward: number; // never cash a word below this unless short of cash
  flushAt: number; // play the whole best split when this few auctions remain
  lowCash: number; // cash a word when the balance drops below this
  cashRevise: number; // cash a word to afford a letter worth at least this much more than our balance (0 = off)
  holdMax: number; // dump a word when the rack grows past this
  sevenPick: number; // 1 = choose 7+ words by reward plus leftover rack value
}

export const DEFAULT_PARAMS: Params = {
  pWin: 0.55,
  costW: 0.5,
  maxMissing: 3,
  minLen: 4,
  w2: 0.3,
  alpha: 1.0,
  beta: 1.2,
  idleBeta: 0.6,
  gamma: 2,
  pace: 0.6,
  capBase: 0.5,
  capPow: 1.5,
  floorMult: 0.9,
  letterTarget: 24,
  slack: 2,
  qW: 0.3,
  endN: 3,
  allIn: 1,
  denyW: 0,
  shade: 0.7,
  holdKappa: 0.85,
  minPlayReward: 35,
  flushAt: 0,
  lowCash: 8,
  cashRevise: 10,
  holdMax: 14,
  sevenPick: 0,
};

// Per-letter predicted price for each fifth of the match.
export type PriceTable = Record<string, number[]>;
export const PHASES = 5;
export function phaseOf(round: number, total: number): number {
  return Math.min(PHASES - 1, Math.floor(((round - 1) * PHASES) / Math.max(1, total)));
}

export interface Strategy {
  decideBid(ctx: BidCtx): number;
  chooseWords(ctx: WordCtx): string[];
  letterValue(ctx: BidCtx): number;
}

// Chance of at least k events from a Poisson with mean m, k = 1..3.
function poissonAtLeast(m: number, k: number): number {
  if (m <= 0) return 0;
  const e = Math.exp(-m);
  let cdf = e;
  let term = e;
  for (let j = 1; j < k; j++) {
    term *= m / j;
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

export function createStrategy(
  dict: Dict = loadDict(),
  params: Partial<Params> = {},
  prices: PriceTable | null = null,
  tops: PriceTable | null = null,
): Strategy {
  const p: Params = { ...DEFAULT_PARAMS, ...params };

  // Fallback prices: roughly what the public data shows.
  const paidOf = (c: number, phase: number) =>
    prices?.[String.fromCharCode(65 + c)]?.[phase] ?? 3 + VALUE[c]!;
  const topOf = (c: number, phase: number) =>
    tops?.[String.fromCharCode(65 + c)]?.[phase] ?? 2 * paidOf(c, phase);

  // Options depend only on the match position, so build them once per
  // auction and cache rack values against them.
  let optsKey = "";
  let optsVal: PotentialOpts | null = null;
  const valCache = new Map<string, number>();

  function opts(ctx: WordCtx): PotentialOpts {
    const key = `${ctx.round}:${ctx.auctionsLeft}:${String.fromCharCode(...ctx.unseen)}`;
    if (key === optsKey && optsVal) return optsVal;
    let U = 0;
    for (let i = 0; i < 26; i++) U += ctx.unseen[i]!;
    const frac = U > 0 ? Math.min(1, ctx.auctionsLeft / U) : 0;
    const phase = phaseOf(ctx.round, ctx.totalRounds);
    const pGet = new Float64Array(78);
    const cost = new Float64Array(26);
    for (let i = 0; i < 26; i++) {
      const u = ctx.unseen[i]!;
      const m = u * frac * p.pWin;
      for (let k = 1; k <= 3; k++) pGet[i * 3 + k - 1] = u >= k ? poissonAtLeast(m, k) : 0;
      cost[i] = p.costW * paidOf(i, phase);
    }
    optsKey = key;
    optsVal = {
      pGet,
      cost,
      maxMissing: Math.max(0, Math.min(p.maxMissing, ctx.auctionsLeft)),
      minLen: p.minLen,
    };
    valCache.clear();
    return optsVal;
  }

  // Rack value: best target plus a share of the best target in the rest.
  function rackValue(r: Rack, o: PotentialOpts): number {
    const key = String.fromCharCode(...r);
    const hit = valCache.get(key);
    if (hit !== undefined) return hit;
    const t = bestTarget(dict, r, o);
    let v = t.value;
    if (p.w2 > 0 && t.word >= 0) {
      const rest = new Uint8Array(r);
      const off = t.word * 26;
      for (let i = 0; i < 26; i++) rest[i] = Math.max(0, rest[i]! - dict.counts[off + i]!);
      if (rackSize(rest) >= 2) v += p.w2 * bestTarget(dict, rest, o).value;
    }
    if (valCache.size > 4096) valCache.clear();
    valCache.set(key, v);
    return v;
  }

  // What a letter adds to the best word of the rival it helps most, from
  // the tiles we've seen it win and not play.
  function denyGain(ctx: BidCtx, c: number): number {
    let best = 0;
    for (const o of ctx.opponents) {
      if (rackSize(o.known) < 4) continue;
      const k0 = bestWord(dict, o.known);
      const r2 = new Uint8Array(o.known);
      r2[c]++;
      const k1 = bestWord(dict, r2);
      const g = (k1 >= 0 ? dict.reward[k1]! : 0) - (k0 >= 0 ? dict.reward[k0]! : 0);
      if (g > best) best = g;
    }
    return best;
  }

  function value(ctx: BidCtx): number {
    if (ctx.auctionsLeft <= 0) return 0; // a tile won on the last auction can't be played
    const c = idx(ctx.letter);
    const o = opts(ctx);
    const withL = new Uint8Array(ctx.rack);
    withL[c]++;
    let delta = Math.max(0, rackValue(withL, o) - rackValue(ctx.rack, o));
    // Near the end the future barely matters: value by what the letter adds
    // to the best set of words we can play before the close.
    if (ctx.auctionsLeft <= p.endN) {
      const dump = bestSplit(dict, withL, 20).score - bestSplit(dict, ctx.rack, 20).score;
      delta = ctx.auctionsLeft === 1 ? Math.max(0, dump) : Math.max(delta, dump);
    }
    return delta;
  }

  function rawBid(ctx: BidCtx, delta: number): number {
    if (ctx.auctionsLeft <= 0) return 0;
    const c = idx(ctx.letter);
    if (ctx.auctionsLeft === 1 && p.allIn >= 1) return delta > 0 ? ctx.balance : 0;

    const faceW = delta > 0 ? p.beta : p.beta * p.idleBeta;
    const spend = ctx.balance / Math.max(1, ctx.auctionsLeft);
    let bid = p.alpha * delta + faceW * VALUE[c]! + p.gamma + p.pace * spend;

    // Behind on tiles: don't let useful letters go below the market.
    const phase = phaseOf(ctx.round, ctx.totalRounds);
    if (p.floorMult > 0) {
      let won = 0;
      for (const r of ctx.results) if (r.winner === ctx.me) won++;
      const behind = won < (p.letterTarget * ctx.round) / ctx.totalRounds - p.slack;
      if (behind && (delta > 0 || rackSize(ctx.rack) < 8)) {
        bid = Math.max(bid, p.floorMult * topOf(c, phase) + 1);
      }
    }
    if (p.denyW > 0) bid = Math.max(bid, p.denyW * denyGain(ctx, c));
    // Almost no words take a Q without a U or an I.
    if (ctx.letter === "Q" && ctx.rack[idx("U")] === 0 && ctx.rack[idx("I")] === 0) bid *= p.qW;
    if (ctx.auctionType === "FirstPrice") bid *= p.shade;
    return bid;
  }

  function capBid(ctx: BidCtx, bid: number): number {
    const frac = (ctx.round - 1) / Math.max(1, ctx.totalRounds - 1);
    const share = Math.min(1, p.capBase + (1 - p.capBase) * Math.pow(frac, p.capPow));
    const cap = ctx.auctionsLeft <= 1 ? ctx.balance : Math.max(1, ctx.balance * share);
    return Math.max(0, Math.min(Math.floor(bid), Math.floor(cap), ctx.balance));
  }

  function decideBid(ctx: BidCtx): number {
    return capBid(ctx, rawBid(ctx, value(ctx)));
  }

  function chooseWords(ctx: WordCtx): string[] {
    // End of match: tiles left over are worth nothing.
    if (ctx.auctionsLeft <= p.flushAt) return bestSplit(dict, ctx.rack).words;

    let rack: Rack = ctx.rack;
    let cash = ctx.balance;
    const out: string[] = [];
    const play = (k: number) => {
      out.push(dict.words[k]!);
      cash += dict.reward[k]!;
      rack = subtract(dict, rack, k);
    };

    // Every 7+ letter word goes at once: the multiplier can't grow further,
    // and the coins fund the next letters. With sevenPick, of the best few
    // pick the one whose leftover tiles are worth most.
    const o = opts(ctx);
    for (;;) {
      const cands = playable(dict, rack, p.sevenPick > 0 ? 8 : 1, 7);
      if (cands.length === 0) break;
      let pick = cands[0]!;
      if (cands.length > 1) {
        let best = -Infinity;
        for (const k of cands) {
          const v = dict.reward[k]! + rackValue(subtract(dict, rack, k), o);
          if (v > best) {
            best = v;
            pick = k;
          }
        }
      }
      play(pick);
    }

    for (let guard = 0; guard < 4; guard++) {
      const k = bestWord(dict, rack, 2);
      if (k < 0) break;
      const rw = dict.reward[k]!;
      let needCash = cash < p.lowCash;
      if (!needCash && p.cashRevise > 0 && ctx.letter && ctx.auctionsLeft > 1) {
        // Cash-then-revise: if this letter is worth clearly more to the rack
        // than we can pay, a word now lets the bot raise its bid before the
        // close. Only for real rack value, not the pace or floor terms.
        const bctx = { ...ctx, letter: ctx.letter, rack, balance: cash } as BidCtx;
        needCash = value(bctx) > cash + p.cashRevise;
      }
      const tooBig = rackSize(rack) > p.holdMax;
      if (!needCash && !tooBig) {
        if (rw < p.minPlayReward) break;
        const rest = subtract(dict, rack, k);
        if (rw + rackValue(rest, o) < p.holdKappa * rackValue(rack, o)) break;
      }
      play(k);
    }
    return out;
  }

  return { decideBid, chooseWords, letterValue: value };
}

// Module-level helpers with the default dictionary and params.
let DEFAULT: Strategy | undefined;
function def(): Strategy {
  DEFAULT ??= createStrategy();
  return DEFAULT;
}
export function decideBid(ctx: BidCtx): number {
  return def().decideBid(ctx);
}
export function chooseWords(ctx: WordCtx): string[] {
  return def().chooseWords(ctx);
}
