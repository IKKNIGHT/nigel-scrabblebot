// Offline rules engine. Mirrors spacetimedb/src/game.ts: the 98-tile bag,
// a 5-tile deal per bot, sequential auctions until the bag is empty,
// Vickrey with reserve 1 (or first-price), random ties, tiles lost when the
// winner can't pay, unbid tiles discarded, floor-rounded rewards, and the
// match ending in the same step as the final auction.

import {
  AUCTION_RESERVE,
  DEFAULT_BAG,
  type SimStrategy,
  SIM_BID_JITTER,
  STARTING_BALANCE,
  STARTING_RACK_SIZE,
  simBid,
  wordReward,
} from "../src/rules.js";
import { buildCtx, type AuctionType, type BidCtx, type MatchRecords, type ResultRec, type WordCtx, type WordRec } from "../src/view.js";
import { isValidWord, findBestPlayable } from "./dictionary.js";

// ---------- seeded RNG ----------

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  // mulberry32
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Inclusive, like ctx.random.integerInRange.
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

// ---------- players ----------

export interface Agent {
  name: string;
  // Server-run sim bot: bids once at open, plays its longest 3+ word after
  // each win.
  sim?: SimStrategy;
  newMatch?(seat: number, seed: number): void;
  decideBid?(ctx: BidCtx): number;
  chooseWords?(ctx: WordCtx): string[];
}

export interface Seat {
  id: string;
  agent: Agent;
  balance: number;
  score: number;
  rack: Map<string, number>;
  rejectedBids: number;
  invalidWords: number;
  errors: number;
  firstError?: string;
  longWords: number;
  longPoints: number;
}

export interface MatchResult {
  seats: { name: string; score: number; place: number; leftover: number; rejectedBids: number; invalidWords: number; errors: number; firstError?: string; longPoints: number }[];
  results: ResultRec[];
  words: WordRec[];
}

export interface MatchOptions {
  seed: number;
  auctionType?: AuctionType;
  rackSize?: number;
}

function addTile(rack: Map<string, number>, c: string) {
  rack.set(c, (rack.get(c) ?? 0) + 1);
}

export function runMatch(agents: Agent[], o: MatchOptions): MatchResult {
  // Two streams: the deal and draw order depend only on the seed, so two
  // versions of a bot played on the same seed see the same tiles in the same
  // order (common random numbers). The server draws everything from one
  // stream; the distribution is the same.
  const bagRng = new Rng(o.seed);
  const rng = new Rng(Math.imul(o.seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0);
  const auctionType: AuctionType = o.auctionType ?? "Vickrey";
  const rackSize = o.rackSize ?? STARTING_RACK_SIZE;

  const bag = new Map<string, number>(DEFAULT_BAG.map(([c, n]) => [c, n]));
  let bagTotal = 0;
  for (const n of bag.values()) bagTotal += n;

  // As drawLetter: a uniform index over the remaining tiles, letters in
  // alphabetical order.
  const drawLetter = (): string | undefined => {
    if (bagTotal === 0) return undefined;
    let i = bagRng.int(0, bagTotal - 1);
    for (const [c] of DEFAULT_BAG) {
      const n = bag.get(c)!;
      if (n <= 0) continue;
      if (i < n) {
        bag.set(c, n - 1);
        bagTotal--;
        return c;
      }
      i -= n;
    }
    return undefined;
  };

  const seats: Seat[] = agents.map((agent, i) => ({
    id: `s${i}`,
    agent,
    balance: STARTING_BALANCE,
    score: 0,
    rack: new Map(),
    rejectedBids: 0,
    invalidWords: 0,
    errors: 0,
    longWords: 0,
    longPoints: 0,
  }));
  seats.forEach((s, i) => s.agent.newMatch?.(i, o.seed));
  for (const s of seats) {
    for (let n = 0; n < rackSize; n++) {
      const c = drawLetter();
      if (c === undefined) break;
      addTile(s.rack, c);
    }
  }

  const results: ResultRec[] = [];
  const words: WordRec[] = [];

  const records = (s: Seat, round: number, letter: string | null): MatchRecords => ({
    me: s.id,
    round,
    auctionsLeft: bagTotal,
    auctionType,
    letter,
    rack: s.rack,
    players: seats.map((p) => ({ bot: p.id, balance: p.balance, score: p.score })),
    results,
    words,
    startingRack: rackSize,
  });

  const playWord = (s: Seat, raw: string): boolean => {
    const word = raw.toUpperCase();
    if (word.length < 2 || !/^[A-Z]+$/.test(word) || !isValidWord(word)) {
      s.invalidWords++;
      return false;
    }
    const need = new Map<string, number>();
    for (const c of word) need.set(c, (need.get(c) ?? 0) + 1);
    for (const [c, n] of need) {
      if ((s.rack.get(c) ?? 0) < n) {
        s.invalidWords++;
        return false;
      }
    }
    for (const [c, n] of need) {
      const left = s.rack.get(c)! - n;
      if (left === 0) s.rack.delete(c);
      else s.rack.set(c, left);
    }
    const reward = wordReward(word);
    s.balance += reward;
    s.score += reward;
    if (word.length >= 7) {
      s.longWords++;
      s.longPoints += reward;
    }
    words.push({ bot: s.id, word, reward });
    return true;
  };

  // A throwing agent forfeits that action, as a crashed client would.
  const safe = <T>(s: Seat, f: () => T, fallback: T): T => {
    try {
      return f();
    } catch (e) {
      s.errors++;
      s.firstError ??= e instanceof Error ? e.stack ?? e.message : String(e);
      return fallback;
    }
  };

  let round = 1;
  let letter = drawLetter();
  while (letter !== undefined) {
    const bids = new Map<string, number>();
    const submit = (s: Seat, amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) return;
      amount = Math.floor(amount);
      // submitBid rejects bids above the balance; the earlier bid stands.
      if (amount > s.balance) {
        s.rejectedBids++;
        return;
      }
      bids.set(s.id, amount);
    };

    // Sim bots bid once at open (simulateBids).
    for (const s of seats) {
      if (!s.agent.sim) continue;
      const jitter = rng.int(-SIM_BID_JITTER, SIM_BID_JITTER);
      const amount = simBid(s.agent.sim, letter, s.balance, jitter);
      if (amount > 0) bids.set(s.id, amount);
    }
    // Client bots: bid, play words, then revise the bid.
    for (const s of seats) {
      if (s.agent.sim) continue;
      const ctx0 = buildCtx(records(s, round, letter)) as BidCtx;
      if (s.agent.decideBid) submit(s, safe(s, () => s.agent.decideBid!(ctx0), 0));
      if (s.agent.chooseWords) {
        const ws = safe(s, () => s.agent.chooseWords!(ctx0), [] as string[]);
        let played = false;
        for (const w of ws) played = playWord(s, w) || played;
        if (played && s.agent.decideBid) {
          const ctx1 = buildCtx(records(s, round, letter)) as BidCtx;
          const again = safe(s, () => s.agent.decideBid!(ctx1), 0);
          if (again > (bids.get(s.id) ?? 0)) submit(s, again);
        }
      }
    }

    // closeAuction: drop zeros, shuffle, stable sort descending.
    const sorted = [...bids].filter(([, a]) => a > 0);
    for (let i = sorted.length - 1; i >= 1; i--) {
      const j = rng.int(0, i);
      [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
    }
    sorted.sort((a, b) => b[1] - a[1]);

    let winner: string | undefined;
    let paid = 0;
    const [first, second] = sorted;
    if (first) {
      winner = first[0];
      paid =
        auctionType === "FirstPrice"
          ? first[1]
          : second
            ? second[1]
            : Math.min(AUCTION_RESERVE, first[1]);
    }
    let simWinner: Seat | undefined;
    if (winner !== undefined) {
      const s = seats.find((x) => x.id === winner)!;
      if (s.balance >= paid) {
        s.balance -= paid;
        addTile(s.rack, letter);
        if (s.agent.sim) simWinner = s;
      }
    }
    results.push({ round, letter, winner, paid });
    if (simWinner) {
      const w = findBestPlayable(simWinner.rack, 3);
      if (w !== undefined) playWord(simWinner, w);
    }

    letter = drawLetter();
    round++;
  }

  const placeOf = (s: Seat) => 1 + seats.filter((x) => x.score > s.score).length;
  return {
    seats: seats.map((s) => ({
      name: s.agent.name,
      score: s.score,
      place: placeOf(s),
      leftover: [...s.rack.values()].reduce((a, b) => a + b, 0),
      rejectedBids: s.rejectedBids,
      invalidWords: s.invalidWords,
      errors: s.errors,
      firstError: s.firstError,
      longPoints: s.longPoints,
    })),
    results,
    words,
  };
}
