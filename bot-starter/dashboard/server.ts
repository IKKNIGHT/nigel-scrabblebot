// Nigel dashboard server. Read-only: it never touches the bot process, its
// token or its files, and it never reads visible_auction_top_bids.
//
//   cd bot-starter && npx tsx dashboard/server.ts      → http://localhost:8787
//   REPLAY=43096 npx tsx dashboard/server.ts           → replays a past match from data/
//
// It joins the game server anonymously with small, filtered subscriptions
// (our seats, our current match, tonight's ratings), reads Nigel's logs and
// live.out, and streams one combined view to the page over SSE.

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { DbConnection } from "../src/module_bindings/index.js";
import { loadDict, bestSplit, bestTarget, type PotentialOpts } from "../src/words.js";
import { BAG, VALUE, idx, rackFromMap, wordReward, letterValue } from "../src/rules.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = (process.env.DASH_BOT ?? "N1gel").toLowerCase();
const REPLAY = process.env.REPLAY ? BigInt(process.env.REPLAY) : null;
const TOURNAMENT_AT = process.env.TOURNAMENT_AT ?? "22:45"; // local time
const TOP_N = 5;
const LOG_DIR = path.join(ROOT, "logs");
const LIVE_OUT = path.join(ROOT, "live.out");

const readJson = <T>(f: string, d: T): T => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")) as T;
  } catch {
    return d;
  }
};
const params = readJson<Record<string, number>>("params.json", {});
const prices = readJson<Record<string, number[]>>("data/price_table.json", {});
const dict = loadDict();
console.log(`[dash] dictionary loaded: ${dict.n} words`);

// ---------- the snapshot both sources produce ----------

interface Part { bot: string; balance: number; score: number; seat: number }
interface Res { auctionId: string; letter: string; winner?: string; paid: number; at: number }
interface WordP { bot: string; word: string; reward: number; at: number }
interface Snap {
  source: "live" | "replay";
  connected: boolean;
  nigel: string | null;
  bots: Map<string, string>;
  stats: Map<string, { mu: number; sigma: number; matches: number; wins: number }>;
  rating: Map<string, { matchId: number; at: number; mu: number; sigma: number }[]>;
  match: null | {
    id: string;
    status: string; // Running | Ended | other
    round: number;
    bagTotal: number;
    auctionType: string;
    startingRack: number;
    startedAt: number | null;
    endedAt: number | null;
    openLetter: string | null;
    openAuctionId: string | null;
    parts: Part[];
    results: Res[];
    words: WordP[];
  };
  tournament: null | { id: string; status: string; round: number; rounds: number; auctionType: string };
}

const ms = (t: { microsSinceUnixEpoch: bigint } | undefined | null) =>
  t ? Number(t.microsSinceUnixEpoch / 1000n) : null;

// ---------- live source ----------

let conn: DbConnection | null = null;
let connected = false;
let nigelId: bigint | null = null;
let watched: bigint | null = null;
let matchHandle: { unsubscribe: () => void } | null = null;
let ratingSubbed = false;
const SINCE = (() => {
  // Tonight = the first match in Nigel's logs.
  try {
    const ids = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => Number(f.slice(0, -6)));
    if (ids.length) return Math.min(...ids);
  } catch { /* */ }
  return Number(process.env.SINCE_MATCH ?? 0);
})();

function liveWatch(c: DbConnection) {
  if (nigelId === null) return;
  let latest: bigint | null = null;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.botId === nigelId && (latest === null || p.matchId > latest)) latest = p.matchId;
  }
  if (latest === null || latest === watched) return;
  const old = matchHandle;
  watched = latest;
  const id = latest;
  console.log(`[dash] watching match ${id}`);
  const h = c
    .subscriptionBuilder()
    .onApplied(() => {
      try { old?.unsubscribe(); } catch { /* */ }
    })
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${id}`,
      `SELECT * FROM match_participant WHERE match_id = ${id}`,
      `SELECT * FROM auction WHERE match_id = ${id}`,
      `SELECT * FROM auction_result WHERE match_id = ${id}`,
      `SELECT * FROM word_play WHERE match_id = ${id}`,
    ]);
  matchHandle = h as unknown as { unsubscribe: () => void };
}

// Nigel plus the current top bots, tonight's rows only (rating_history has
// a row per bot per match: a top bot has thousands).
function liveRatings(c: DbConnection) {
  if (ratingSubbed || nigelId === null) return;
  const rows = [...c.db.botStats.iter()];
  if (!rows.length) return;
  ratingSubbed = true;
  const sim = new Set([...c.db.bot.iter()].filter((b) => b.isSimulated).map((b) => b.id));
  const top = rows
    .filter((s) => s.botId !== nigelId && !sim.has(s.botId) && spread(s.openskillSigma) <= 175)
    .sort((a, b) => b.openskillMu - a.openskillMu)
    .slice(0, TOP_N)
    .map((s) => s.botId);
  for (const id of [nigelId, ...top]) {
    c.subscriptionBuilder()
      .onError(() => {
        console.warn(`[dash] rating_history filter refused for bot ${id}; trying bot only for Nigel`);
        if (id === nigelId) c.subscriptionBuilder().subscribe(`SELECT * FROM rating_history WHERE bot_id = ${id}`);
      })
      .subscribe(`SELECT * FROM rating_history WHERE bot_id = ${id} AND match_id >= ${SINCE}`);
  }
}

function connectLive() {
  console.log(`[dash] connecting to ${DB_NAME} at ${HOST} (anonymous)`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .onConnect((c) => {
      conn = c;
      connected = true;
      watched = null;
      matchHandle = null;
      ratingSubbed = false;
      c.subscriptionBuilder()
        .onApplied(() => {
          for (const b of c.db.bot.iter()) if (b.name.toLowerCase() === BOT_NAME) nigelId = b.id;
          if (nigelId === null) { console.error(`[dash] no bot named ${BOT_NAME}`); return; }
          console.log(`[dash] ${BOT_NAME} is bot ${nigelId}`);
          c.subscriptionBuilder()
            .onApplied(() => liveWatch(c))
            .subscribe(`SELECT * FROM match_participant WHERE bot_id = ${nigelId}`);
          liveRatings(c);
        })
        .subscribe(["SELECT * FROM bot", "SELECT * FROM bot_stats", "SELECT * FROM tournament"]);
      c.db.matchParticipant.onInsert(() => liveWatch(c));
    })
    .onConnectError((_ctx, err) => {
      console.error("[dash] connect error:", err.message);
      connected = false;
      setTimeout(connectLive, 3000);
    })
    .onDisconnect(() => {
      console.log("[dash] disconnected");
      connected = false;
      conn = null;
      setTimeout(connectLive, 3000);
    })
    .build();
}

function liveSnap(): Snap {
  const s: Snap = {
    source: "live", connected, nigel: nigelId === null ? null : String(nigelId),
    bots: new Map(), stats: new Map(), rating: new Map(), match: null, tournament: null,
  };
  const c = conn;
  if (!c) return s;
  for (const b of c.db.bot.iter()) s.bots.set(String(b.id), b.name);
  for (const r of c.db.botStats.iter())
    s.stats.set(String(r.botId), { mu: r.openskillMu, sigma: r.openskillSigma, matches: r.matchesPlayed, wins: r.wins });
  for (const r of c.db.ratingHistory.iter()) {
    if (Number(r.matchId) < SINCE) continue;
    const k = String(r.botId);
    if (!s.rating.has(k)) s.rating.set(k, []);
    s.rating.get(k)!.push({ matchId: Number(r.matchId), at: ms(r.at) ?? 0, mu: r.openskillMu, sigma: r.openskillSigma });
  }
  let tour = null as Snap["tournament"];
  for (const t of c.db.tournament.iter()) {
    if (!tour || BigInt(tour.id) < t.id)
      tour = { id: String(t.id), status: t.status.tag, round: t.currentRound, rounds: t.swissRoundsTotal, auctionType: t.auctionType.tag };
  }
  s.tournament = tour;
  if (watched === null) return s;
  const m = c.db.matchState.id.find(watched);
  if (!m) return s;
  const id = watched;
  let openLetter: string | null = null;
  let openAuctionId: string | null = null;
  if (m.currentAuctionId !== undefined) {
    const a = c.db.auction.id.find(m.currentAuctionId);
    if (a && a.status.tag === "Open") { openLetter = a.letter; openAuctionId = String(a.id); }
  }
  s.match = {
    id: String(id),
    status: m.status.tag,
    round: m.currentRound,
    bagTotal: m.bagTotal,
    auctionType: m.auctionType.tag,
    startingRack: m.startingRackSize,
    startedAt: ms(m.startedAt),
    endedAt: ms(m.endedAt),
    openLetter,
    openAuctionId,
    parts: [...c.db.matchParticipant.iter()]
      .filter((p) => p.matchId === id)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((p, i) => ({ bot: String(p.botId), balance: Number(p.balance), score: Number(p.score), seat: i })),
    results: [...c.db.auctionResult.iter()]
      .filter((r) => r.matchId === id)
      .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
      .map((r) => ({
        auctionId: String(r.auctionId), letter: r.letter,
        winner: r.winnerBotId !== undefined ? String(r.winnerBotId) : undefined,
        paid: Number(r.paid), at: ms(r.closedAt) ?? 0,
      })),
    words: [...c.db.wordPlay.iter()]
      .filter((w) => w.matchId === id)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((w) => ({ bot: String(w.botId), word: w.word, reward: Number(w.totalReward), at: ms(w.playedAt) ?? 0 })),
  };
  return s;
}

// ---------- replay source (testing without the server) ----------

type Rows = unknown[][];
const rowsOf = (f: string): Rows => readJson<{ rows: Rows }[]>(`data/${f}.json`, [{ rows: [] }])[0]?.rows ?? [];
const some = (v: unknown) => (Array.isArray(v) && v[0] === 0 ? v[1] : undefined);
let replay: null | {
  t0: number; start: number; end: number;
  bots: Map<string, string>; stats: Snap["stats"];
  parts: string[]; results: Res[]; words: WordP[]; nigel: string;
} = null;

function loadReplay(id: bigint) {
  const mid = Number(id);
  const bots = new Map<string, string>();
  for (const r of rowsOf("bot")) bots.set(String(r[0]), String(r[1]));
  const stats: Snap["stats"] = new Map();
  for (const r of rowsOf("bot_stats"))
    stats.set(String(r[0]), { mu: Number(r[6]), sigma: Number(r[7]), matches: Number(r[2]), wins: Number(r[3]) });
  const parts = rowsOf("match_participant").filter((r) => r[1] === mid).sort((a, b) => Number(a[0]) - Number(b[0])).map((r) => String(r[2]));
  const results = rowsOf("auction_result")
    .filter((r) => r[1] === mid)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map((r) => {
      const w = some(r[3]);
      return { auctionId: String(r[0]), letter: String(r[2]), winner: w === undefined ? undefined : String(w), paid: Number(r[4]), at: Math.floor(Number((r[5] as number[])[0]) / 1000) };
    });
  const words = rowsOf("word_play")
    .filter((r) => r[1] === mid)
    .map((r) => ({ bot: String(r[2]), word: String(r[3]), reward: Number(r[6]), at: Math.floor(Number((r[7] as number[])[0]) / 1000) }))
    .sort((a, b) => a.at - b.at);
  const nigel = [...bots].find(([, n]) => n.toLowerCase() === BOT_NAME)?.[0] ?? "209";
  const start = results[0]!.at - 1000;
  replay = { t0: Date.now(), start, end: results.at(-1)!.at, bots, stats, parts, results, words, nigel };
  console.log(`[dash] replaying match ${mid}: ${results.length} auctions, ${words.length} words`);
}

// The replay clock: match time now. Loops with a 12 s gap between runs.
function replayTime(): number {
  const r = replay!;
  const len = r.end - r.start + 12000;
  return r.start + ((Date.now() - r.t0) % len);
}

function replaySnap(): Snap {
  const r = replay!;
  const T = replayTime();
  const results = r.results.filter((x) => x.at <= T);
  const words = r.words.filter((x) => x.at <= T);
  const ended = T >= r.end;
  const next = r.results[results.length];
  const parts = r.parts.map((bot, seat) => {
    let bal = 100, score = 0;
    for (const x of results) if (x.winner === bot) bal -= x.paid;
    for (const w of words) if (w.bot === bot) { bal += w.reward; score += w.reward; }
    return { bot, balance: bal, score, seat };
  });
  // Fake rating lines so the chart has something to draw in replay.
  const rating: Snap["rating"] = new Map();
  const tops = [...r.stats].filter(([b]) => b !== r.nigel).sort((a, b) => b[1].mu - a[1].mu).slice(0, TOP_N);
  for (const [b, st] of [[r.nigel, r.stats.get(r.nigel) ?? { mu: 25, sigma: 8, matches: 0, wins: 0 }] as const, ...tops]) {
    const pts = [];
    let mu = b === r.nigel ? 25 : st.mu - 1.5;
    for (let i = 0; i < 40; i++) {
      mu += b === r.nigel ? 0.35 + Math.sin(i * 1.7) * 0.6 : Math.sin(i * 0.9 + Number(b)) * 0.25 + 0.04;
      pts.push({ matchId: SINCE + i * 6, at: Date.now() - (40 - i) * 75000, mu, sigma: b === r.nigel ? Math.max(1.2, 8 - i * 0.17) : st.sigma });
    }
    rating.set(b, pts);
  }
  return {
    source: "replay", connected: true, nigel: r.nigel, bots: r.bots, stats: r.stats, rating,
    match: {
      id: String(REPLAY), status: ended ? "Ended" : "Running", round: Math.min(68, results.length + 1),
      bagTotal: Math.max(0, 67 - results.length), auctionType: "Vickrey", startingRack: 5,
      startedAt: r.start, endedAt: ended ? r.end : null,
      openLetter: ended ? null : next?.letter ?? null, openAuctionId: ended ? null : next?.auctionId ?? null,
      parts, results, words,
    },
    tournament: null,
  };
}

const now = () => (replay ? replayTime() : Date.now());

// ---------- Nigel's logs ----------

interface Ev { t: number; event: string; [k: string]: unknown }
interface LogMatch {
  id: number; start: number; events: Ev[];
  bids: Map<string, number>; // auctionId -> highest amount sent
  end?: Ev;
}
const logCache = new Map<string, { size: number; m: LogMatch }>();

function readLogs(): LogMatch[] {
  let files: string[] = [];
  try { files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  const out: LogMatch[] = [];
  for (const f of files) {
    const p = path.join(LOG_DIR, f);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { continue; }
    const hit = logCache.get(f);
    if (hit && hit.size === size) { out.push(hit.m); continue; }
    const events: Ev[] = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as Ev); } catch { /* partial line */ }
    }
    const bids = new Map<string, number>();
    for (const e of events) if (e.event === "bid") {
      const k = String(e.auctionId);
      bids.set(k, Math.max(bids.get(k) ?? 0, Number(e.amount)));
    }
    const m: LogMatch = { id: Number(f.slice(0, -6)), start: events[0]?.t ?? 0, events, bids, end: events.find((e) => e.event === "end") };
    logCache.set(f, { size, m });
    out.push(m);
  }
  return out.sort((a, b) => a.id - b.id);
}

// ---------- live.out: restarts, versions, errors ----------

interface Restart { at: number; label: string; line: number }
function readLiveOut() {
  let text = "";
  let mtime = 0;
  try { text = fs.readFileSync(LIVE_OUT, "utf8"); mtime = fs.statSync(LIVE_OUT).mtimeMs; } catch { /* */ }
  const lines = text.split(/\r?\n/);
  const restarts: Restart[] = [];
  lines.forEach((l, i) => {
    const m = /^=== restart (\d\d):(\d\d):(\d\d)\s*(.*?)\s*===\s*$/.exec(l);
    if (!m) return;
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
    if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1);
    restarts.push({ at: d.getTime(), label: m[4] || "restart", line: i });
  });
  const from = restarts.at(-1)?.line ?? 0;
  const tail = lines.slice(from + 1);
  const errs = tail.filter((l) => /failed|error|uncaught|unhandled/i.test(l));
  return {
    mtime,
    restarts,
    reconnects: tail.filter((l) => /reconnecting in/.test(l)).length,
    disconnects: tail.filter((l) => /^disconnected/.test(l)).length,
    errors: errs.length,
    lastError: errs.at(-1)?.replace(/^\[[^\]]*\]\s*/, "") ?? null,
  };
}

// ---------- derived view ----------

const ELO = 400 / (Math.LN10 * (25 / 6) * Math.SQRT2);
const skill = (mu: number) => Math.round(1500 + ELO * (mu - 25));
function spread(sigma: number) { return Math.round(ELO * sigma); }
const mult = (n: number) => (n <= 3 ? 1 : n === 4 ? 1.5 : n === 5 ? 2 : n === 6 ? 2.5 : 3);

function poissonAtLeast(m: number, k: number) {
  let term = Math.exp(-m), cdf = term;
  for (let i = 1; i < k; i++) { term *= m / i; cdf += term; }
  return Math.max(0, 1 - cdf);
}
const phaseOf = (round: number, total: number) => Math.min(4, Math.floor(((round - 1) * 5) / Math.max(1, total)));

const planCache = new Map<string, unknown>();
function plan(rackStr: string, round: number, auctionsLeft: number, unseen: Int32Array) {
  const key = `${rackStr}:${round}`;
  if (planCache.has(key)) return planCache.get(key);
  const rm = new Map<string, number>();
  for (const c of rackStr) rm.set(c, (rm.get(c) ?? 0) + 1);
  const rack = rackFromMap(rm);
  const split = rackStr.length >= 2 ? bestSplit(dict, rack, 30) : { words: [], score: 0 };
  let U = 0;
  for (let i = 0; i < 26; i++) U += unseen[i]!;
  const frac = U > 0 ? Math.min(1, auctionsLeft / U) : 0;
  const pWin = params.pWin ?? 0.55, costW = params.costW ?? 0.5;
  const pGet = new Float64Array(78), cost = new Float64Array(26);
  const phase = phaseOf(round, round + auctionsLeft);
  for (let i = 0; i < 26; i++) {
    const u = unseen[i]!;
    for (let k = 1; k <= 3; k++) pGet[i * 3 + k - 1] = u < k ? 0 : poissonAtLeast(u * frac * pWin, k);
    cost[i] = costW * (prices[String.fromCharCode(65 + i)]?.[phase] ?? 3 + VALUE[i]!);
  }
  const o: PotentialOpts = {
    pGet, cost,
    maxMissing: Math.max(0, Math.min(params.maxMissing ?? 3, auctionsLeft)),
    minLen: params.minLen ?? 4,
  };
  const t = rackStr.length ? bestTarget(dict, rack, o) : { word: -1, value: 0 };
  const target = t.word >= 0 ? dict.words[t.word]! : null;
  let missing = "";
  if (target) {
    const have = new Map(rm);
    for (const c of target) {
      const n = have.get(c) ?? 0;
      if (n > 0) have.set(c, n - 1); else missing += c;
    }
  }
  const out = {
    best: split.words.length ? { words: split.words, reward: split.score } : null,
    target: target ? { word: target, reward: wordReward(target), missing } : null,
  };
  if (planCache.size > 500) planCache.clear();
  planCache.set(key, out);
  return out;
}

function build() {
  const s = replay ? replaySnap() : liveSnap();
  const T = now();
  const logs = readLogs();
  const lo = readLiveOut();
  const name = (b?: string) => (b ? s.bots.get(b) ?? `bot ${b}` : "no one");
  const nigel = s.nigel;

  // Record per ended match, tagged with the params version running then.
  const versionAt = (t: number) => {
    let v = "before restarts";
    for (const r of lo.restarts) if (r.at <= t) v = r.label;
    return v;
  };
  const record = logs
    .filter((m) => m.end && (!replay || m.start <= T))
    .map((m) => {
      const e = m.end!;
      const words = m.events.filter((x) => x.event === "word").map((x) => String(x.word));
      const pts = words.reduce((a, w) => a + wordReward(w), 0);
      const sevenPts = words.filter((w) => w.length >= 7).reduce((a, w) => a + wordReward(w), 0);
      const won = m.events.filter((x) => x.event === "result" && x.won);
      const leftover = String(e.leftover ?? "");
      return {
        id: m.id, t: m.start, place: Number(e.place), score: Number(e.score), coins: Number(e.balance),
        leftover, tilesWon: won.length, sevens: words.filter((w) => w.length >= 7).length,
        sevenShare: pts ? sevenPts / pts : 0,
        qSpent: won.filter((x) => x.letter === "Q").reduce((a, x) => a + Number(x.paid), 0),
        version: versionAt(m.start),
      };
    });
  const agg = (rs: typeof record) => {
    const n = rs.length || 1;
    return {
      n: rs.length,
      avgPlace: rs.reduce((a, r) => a + r.place, 0) / n,
      winRate: rs.filter((r) => r.place === 1).length / n,
      avgScore: rs.reduce((a, r) => a + r.score, 0) / n,
      avgCoins: rs.reduce((a, r) => a + r.coins, 0) / n,
      stranded: rs.filter((r) => r.leftover.length > 0).length,
      strandedQ: rs.filter((r) => r.leftover.includes("Q")).length,
      leftTiles: rs.reduce((a, r) => a + r.leftover.length, 0) / n,
      sevenShare: rs.reduce((a, r) => a + r.sevenShare, 0) / n,
      tilesWon: rs.reduce((a, r) => a + r.tilesWon, 0) / n,
    };
  };
  const cur = lo.restarts.at(-1);
  const sinceV = cur ? record.filter((r) => r.t >= cur.at) : record;
  const beforeV = cur ? record.filter((r) => r.t < cur.at) : [];

  // The current match.
  const m = s.match;
  let match = null as unknown;
  if (m) {
    const log = logs.find((l) => String(l.id) === m.id);
    const evs = log ? log.events.filter((e) => e.t <= T) : [];
    const lastBid = [...evs].reverse().find((e) => e.event === "bid");
    const results = m.results;
    // Racks: what each bot is known to hold (won minus played), plus tiles
    // dealt face down. Nigel's own rack comes from its log.
    const seats = m.parts.map((p) => {
      const net = new Map<string, number>();
      for (const r of results) if (r.winner === p.bot) net.set(r.letter, (net.get(r.letter) ?? 0) + 1);
      let fromDealt = 0;
      for (const w of m.words) if (w.bot === p.bot) for (const c of w.word) net.set(c, (net.get(c) ?? 0) - 1);
      let known = "";
      for (const [c, n] of [...net].sort()) { if (n < 0) fromDealt -= n; else known += c.repeat(n); }
      const isNigel = p.bot === nigel;
      const st = s.stats.get(p.bot);
      return {
        bot: p.bot, name: name(p.bot), seat: p.seat, isNigel,
        score: p.score, coins: p.balance,
        tilesWon: results.filter((r) => r.winner === p.bot).length,
        words: m.words.filter((w) => w.bot === p.bot).length,
        rack: isNigel && lastBid ? String(lastBid.rack) : known,
        hidden: isNigel && lastBid ? 0 : Math.max(0, m.startingRack - fromDealt),
        rating: st ? skill(st.mu) : null,
      };
    });
    const ranked = [...seats].sort((a, b) => b.score - a.score);
    for (const x of seats) (x as Record<string, unknown>).place = 1 + seats.filter((y) => y.score > x.score).length;

    const me = seats.find((x) => x.isNigel);
    let nigelView = null;
    if (me) {
      // Tiles still to come, as Nigel sees them (bag minus auctioned minus its dealt tiles).
      const dealt = new Int32Array(26);
      for (const c of me.rack) dealt[idx(c)]++;
      for (const w of m.words) if (w.bot === nigel) for (const c of w.word) dealt[idx(c)]++;
      for (const r of results) if (r.winner === nigel) dealt[idx(r.letter)]--;
      const unseen = new Int32Array(26);
      for (let i = 0; i < 26; i++) unseen[i] = BAG[i]! - Math.max(0, dealt[i]!);
      for (const r of results) unseen[idx(r.letter)]--;
      if (m.openLetter) unseen[idx(m.openLetter)]--;
      for (let i = 0; i < 26; i++) if (unseen[i]! < 0) unseen[i] = 0;
      const bidMs = evs.filter((e) => e.event === "bid").map((e) => Number(e.ms)).sort((a, b) => a - b);
      nigelView = {
        rack: me.rack,
        plan: m.status === "Running" ? plan(me.rack, m.round, m.bagTotal, unseen) : null,
        openBid: m.openAuctionId ? log?.bids.get(m.openAuctionId) ?? null : null,
        lastBidAt: lastBid?.t ?? null,
        bidMsMax: bidMs.at(-1) ?? null,
        bidMsMed: bidMs.length ? bidMs[Math.floor(bidMs.length / 2)] : null,
        errors: evs.filter((e) => e.event === "error").length,
      };
    }
    const bidFor = (aid: string) => (log ? evsBid(log, aid, T) : null);
    match = {
      id: m.id, status: m.status, round: m.round, total: m.round + m.bagTotal, auctionType: m.auctionType,
      startedAt: m.startedAt, endedAt: m.endedAt,
      open: m.openLetter ? { letter: m.openLetter, value: letterValue(m.openLetter), nigelBid: nigelView?.openBid ?? null } : null,
      strip: results.map((r) => (r.winner === undefined ? 0 : r.winner === nigel ? 2 : 1)),
      results: results.slice(-8).reverse().map((r) => ({
        id: r.auctionId, letter: r.letter, winner: r.winner ?? null, winnerName: name(r.winner),
        paid: r.paid, nigelBid: bidFor(r.auctionId), won: r.winner === nigel,
      })),
      words: m.words.slice(-14).reverse().map((w) => ({
        bot: w.bot, name: name(w.bot), word: w.word, reward: w.reward, mult: mult(w.word.length), isNigel: w.bot === nigel, at: w.at,
      })),
      seats, standings: ranked.map((x) => x.bot), nigel: nigelView,
    };
  }

  // Market: what letters sold for in Nigel's last 10 matches vs its price table.
  const recent = logs.slice(-10);
  const sold = new Map<string, number[]>();
  for (const l of recent) for (const e of l.events) {
    if (e.event !== "result" || !e.winner || Number(e.paid) <= 1) continue;
    const c = String(e.letter);
    if (!sold.has(c)) sold.set(c, []);
    sold.get(c)!.push(Number(e.paid));
  }
  const market = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => {
    const xs = sold.get(c) ?? [];
    const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const tab = prices[c] ? prices[c]!.reduce((a, b) => a + b, 0) / prices[c]!.length : null;
    return { letter: c, value: letterValue(c), avg, table: tab, n: xs.length, ratio: avg && tab ? avg / tab : null };
  });

  // Ratings: tonight's line for Nigel and the top bots.
  const series = [...s.rating].map(([bot, pts]) => ({
    bot, name: name(bot), isNigel: bot === nigel,
    pts: pts.sort((a, b) => a.matchId - b.matchId).map((p) => ({ at: p.at, r: skill(p.mu) })),
  }));
  const stats = [...s.stats].map(([b, st]) => ({ b, r: skill(st.mu), sp: spread(st.sigma) })).filter((x) => x.sp <= 175).sort((a, b) => b.r - a.r);
  const nst = nigel ? s.stats.get(nigel) : undefined;
  const rankIdx = nigel ? stats.findIndex((x) => x.b === nigel) : -1;

  // Health.
  const lastLog = logs.at(-1);
  const lastEventT = lastLog?.events.at(-1)?.t ?? 0;
  const inMatch = (match as { status?: string } | null)?.status === "Running";
  const tour = (() => {
    const [h, mi] = TOURNAMENT_AT.split(":").map(Number);
    const d = new Date(); d.setHours(h!, mi!, 0, 0);
    return d.getTime();
  })();

  return {
    now: T, source: s.source,
    server: s.connected,
    nigel: nigel ? { id: nigel, name: name(nigel), rating: nst ? skill(nst.mu) : null, spread: nst ? spread(nst.sigma) : null, rank: rankIdx >= 0 ? rankIdx + 1 : null, matches: nst?.matches ?? null } : null,
    match,
    record: record.slice(-40).map((r) => ({ id: r.id, place: r.place, score: r.score, coins: r.coins, leftover: r.leftover, version: r.version })),
    tonight: agg(record),
    last10: agg(record.slice(-10)),
    version: { label: cur?.label ?? "first run", since: cur?.at ?? null, now: agg(sinceV), before: agg(beforeV) },
    market,
    rating: { series },
    health: {
      inMatch,
      lastBidAgo: inMatch && (match as { nigel?: { lastBidAt: number | null } }).nigel?.lastBidAt ? T - (match as { nigel: { lastBidAt: number } }).nigel.lastBidAt : null,
      idleFor: !inMatch && lastEventT ? T - lastEventT : null,
      liveOutAge: lo.mtime ? Date.now() - lo.mtime : null,
      restartAt: cur?.at ?? null,
      reconnects: lo.reconnects, disconnects: lo.disconnects, errors: lo.errors, lastError: lo.lastError,
    },
    tournament: { at: tour, current: s.tournament },
  };
}

function evsBid(l: LogMatch, aid: string, T: number): number | null {
  let best: number | null = null;
  for (const e of l.events) if (e.event === "bid" && e.t <= T && String(e.auctionId) === aid) best = Math.max(best ?? 0, Number(e.amount));
  return best;
}

// ---------- HTTP + SSE ----------

const clients = new Set<http.ServerResponse>();
let lastJson = "";
function tick() {
  let json: string;
  try {
    json = JSON.stringify(build());
  } catch (err) {
    console.error("[dash] build failed:", err);
    return;
  }
  if (json === lastJson) return;
  lastJson = json;
  for (const res of clients) res.write(`data: ${json}\n\n`);
}

http
  .createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`retry: 2000\n\n`);
      if (lastJson) res.write(`data: ${lastJson}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(lastJson || "{}");
      return;
    }
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(fs.readFileSync(path.join(HERE, "index.html")));
      return;
    }
    res.writeHead(404).end();
  })
  .listen(PORT, () => console.log(`[dash] open http://localhost:${PORT}`));

setInterval(() => { for (const r of clients) r.write(": ping\n\n"); }, 15000);
if (REPLAY !== null) loadReplay(REPLAY);
else connectLive();
setInterval(tick, 200);
