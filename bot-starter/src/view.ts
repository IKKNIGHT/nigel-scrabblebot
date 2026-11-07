// What a bot can see of a match, built from public tables plus its own rack.
// The live bot fills `MatchRecords` from its subscription; the sim fills it
// from the engine's state. Both then call `buildCtx`, so the strategy gets
// identical inputs in both places.

import { BAG, idx, type Rack, rackFromMap } from "./rules.js";

export type AuctionType = "Vickrey" | "FirstPrice";

export interface ResultRec {
  round: number;
  letter: string;
  winner?: string; // bot id; undefined = no bids
  paid: number;
}
export interface WordRec {
  bot: string;
  word: string;
  reward: number;
}
export interface PlayerRec {
  bot: string;
  balance: number;
  score: number;
}

export interface MatchRecords {
  me: string;
  round: number; // current auction, 1-based
  auctionsLeft: number; // auctions after the current one
  auctionType: AuctionType;
  letter: string | null; // letter on auction now
  rack: ReadonlyMap<string, number>; // my rack in this match
  players: PlayerRec[];
  results: ResultRec[]; // closed auctions
  words: WordRec[];
  startingRack: number; // tiles dealt to each bot
}

export interface Opponent {
  bot: string;
  balance: number;
  score: number;
  known: Rack; // won tiles minus played tiles (may go negative before
  // their dealt tiles show up; clamped to 0)
  hidden: number; // dealt tiles not yet seen in a word
}

export interface WordCtx {
  me: string;
  rack: Rack;
  rackMap: Map<string, number>;
  balance: number;
  score: number;
  round: number;
  totalRounds: number;
  auctionsLeft: number;
  auctionType: AuctionType;
  // Tiles that may still be auctioned: the bag minus every letter auctioned
  // (including the current one) minus my dealt tiles. Includes rivals'
  // hidden dealt tiles, which we can't see.
  unseen: Int32Array;
  opponents: Opponent[];
  letter: string | null;
  results: readonly ResultRec[];
  words: readonly WordRec[];
}

export interface BidCtx extends WordCtx {
  letter: string;
}

export function buildCtx(m: MatchRecords): WordCtx {
  const rack = rackFromMap(m.rack);
  const me = m.players.find((p) => p.bot === m.me);

  // My dealt tiles = rack + played - won.
  const dealt = new Int32Array(26);
  for (let i = 0; i < 26; i++) dealt[i] = rack[i]!;
  for (const w of m.words) if (w.bot === m.me) for (const c of w.word) dealt[idx(c)]++;
  for (const r of m.results) if (r.winner === m.me) dealt[idx(r.letter)]--;

  const unseen = new Int32Array(26);
  for (let i = 0; i < 26; i++) unseen[i] = BAG[i]! - Math.max(0, dealt[i]!);
  for (const r of m.results) unseen[idx(r.letter)]--;
  if (m.letter) unseen[idx(m.letter)]--;
  for (let i = 0; i < 26; i++) if (unseen[i]! < 0) unseen[i] = 0;

  const opponents: Opponent[] = [];
  for (const p of m.players) {
    if (p.bot === m.me) continue;
    const net = new Int32Array(26);
    for (const r of m.results) if (r.winner === p.bot) net[idx(r.letter)]++;
    let fromDealt = 0;
    for (const w of m.words) {
      if (w.bot !== p.bot) continue;
      for (const c of w.word) {
        net[idx(c)]--;
      }
    }
    const known = new Uint8Array(26);
    for (let i = 0; i < 26; i++) {
      if (net[i]! < 0) fromDealt -= net[i]!;
      known[i] = Math.max(0, net[i]!);
    }
    opponents.push({
      bot: p.bot,
      balance: p.balance,
      score: p.score,
      known,
      hidden: Math.max(0, m.startingRack - fromDealt),
    });
  }

  return {
    me: m.me,
    rack,
    rackMap: new Map(m.rack),
    balance: me?.balance ?? 0,
    score: me?.score ?? 0,
    round: m.round,
    totalRounds: m.round + m.auctionsLeft,
    auctionsLeft: m.auctionsLeft,
    auctionType: m.auctionType,
    unseen,
    opponents,
    letter: m.letter,
    results: m.results,
    words: m.words,
  };
}
