// Game rules, copied from the server (spacetimedb/src/letters.ts and
// spacetimedb/src/game.ts, MIT, Clockwork Labs). Shared by the live bot and
// the sim so both score words exactly as the server does.

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const A = 65;

export function letterValue(c: string): number {
  switch (c) {
    case "A":
    case "E":
    case "I":
    case "O":
    case "U":
    case "L":
    case "N":
    case "S":
    case "T":
    case "R":
      return 1;
    case "D":
    case "G":
      return 2;
    case "B":
    case "C":
    case "M":
    case "P":
      return 3;
    case "F":
    case "H":
    case "V":
    case "W":
    case "Y":
      return 4;
    case "K":
      return 5;
    case "J":
    case "X":
      return 8;
    case "Q":
    case "Z":
      return 10;
    default:
      return 0;
  }
}

// Standard Scrabble distribution, no blanks. 98 tiles total.
export const BAG_SIZE = 98;
export const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
];

// Length-based reward multiplier as (numerator, denominator).
// totalReward = baseScore * num / denom (integer division).
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += letterValue(c);
  const [num, den] = lengthMultiplier(word.length);
  return Math.floor((base * num) / den);
}

export const STARTING_BALANCE = 100;
export const STARTING_RACK_SIZE = 5;
export const LOBBY_MAX_SIZE = 6;
export const AUCTION_RESERVE = 1;
export const SIM_BID_JITTER = 2;
// 98 tiles - 6 bots × 5 dealt.
export const AUCTIONS_PER_MATCH = BAG_SIZE - LOBBY_MAX_SIZE * STARTING_RACK_SIZE;

// Value per slot, and the bag as a 26-slot count array.
export const VALUE: number[] = [...LETTERS].map(letterValue);
export const BAG: number[] = (() => {
  const b = new Array<number>(26).fill(0);
  for (const [c, n] of DEFAULT_BAG) b[c.charCodeAt(0) - A] = n;
  return b;
})();

export function idx(c: string): number {
  return c.charCodeAt(0) - A;
}

export type Rack = Uint8Array; // 26 counts

export function rackFromMap(m: ReadonlyMap<string, number>): Rack {
  const r = new Uint8Array(26);
  for (const [c, n] of m) {
    const i = idx(c);
    if (i >= 0 && i < 26) r[i] += n;
  }
  return r;
}

export function rackToMap(r: Rack): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < 26; i++) if (r[i]) m.set(LETTERS[i]!, r[i]!);
  return m;
}

export function rackSize(r: Rack): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += r[i]!;
  return n;
}

export function rackString(r: Rack): string {
  let s = "";
  for (let i = 0; i < 26; i++) s += LETTERS[i]!.repeat(r[i]!);
  return s;
}

// Sim-bot bid rule, copied from game.ts `decideBid`.
export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";
export function simBid(
  strategy: SimStrategy,
  letter: string,
  balance: number,
  jitter: number,
): number {
  const value = letterValue(letter);
  const isVowel = "AEIOU".includes(letter);
  let base: number;
  switch (strategy) {
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (isVowel ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}
