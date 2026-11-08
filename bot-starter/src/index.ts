// Nigel — live client. Built on the official bot starter (MIT, Clockwork
// Labs): same connection, credential and lobby flow, plus richer strategy
// inputs, bid revision, JSONL logs and auto-reconnect.
//
// First run: `BOT_NAME=nigel BOT_TOKEN=<token> npm start` (token from /team).
// Later runs: `BOT_NAME=nigel npm start`. Tournament: add TOURNAMENT_ID=<id>.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { createStrategy, type PriceTable } from "./strategy.js";
import { loadDict } from "./words.js";
import { buildCtx, type MatchRecords, type BidCtx } from "./view.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "nigel";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const LOG_DIR = path.join(process.cwd(), "logs");

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), file), "utf8")) as T;
  } catch {
    return null;
  }
}

// Load the dictionary and strategy before connecting.
const dict = loadDict();
const strategy = createStrategy(
  dict,
  readJson("params.json") ?? {},
  readJson<PriceTable>("data/price_table.json"),
  readJson<PriceTable>("data/top_table.json"),
);
console.log(`[${BOT_NAME}] dictionary loaded: ${dict.n} words`);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let claimedNonce = false;
// auction id -> amount sent, so a revision only goes out when it's higher.
const bidSent = new Map<bigint, number>();
// match id -> rack signature we last sent words for.
const wordsSentFor = new Map<bigint, string>();

// ---------- logging ----------

function log(matchId: bigint, event: Record<string, unknown>) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, `${matchId}.jsonl`),
      JSON.stringify({ t: Date.now(), ...event }, (_k, v) =>
        typeof v === "bigint" ? Number(v) : v,
      ) + "\n",
    );
  } catch {
    /* logging must never stop the bot */
  }
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing.
function logFailure(matchId: bigint, what: string) {
  return (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${BOT_NAME}] ${what} failed: ${msg}`);
    log(matchId, { event: "error", what, msg });
  };
}

// ---------- match view ----------

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function records(conn: DbConnection, matchId: bigint): MatchRecords | null {
  if (myBotId === null) return null;
  const m = conn.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return null;

  const players = [];
  let inMatch = false;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId === myBotId) inMatch = true;
    players.push({ bot: String(p.botId), balance: Number(p.balance), score: Number(p.score) });
  }
  if (!inMatch) return null;

  const rack = new Map<string, number>();
  // Racks span matches; keep only this one's.
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }

  const results = [...conn.db.auctionResult.iter()]
    .filter((r) => r.matchId === matchId)
    .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
    .map((r, i) => ({
      round: i + 1,
      letter: r.letter,
      winner: r.winnerBotId != null ? String(r.winnerBotId) : undefined,
      paid: Number(r.paid),
    }));
  const words = [...conn.db.wordPlay.iter()]
    .filter((w) => w.matchId === matchId)
    .map((w) => ({ bot: String(w.botId), word: w.word, reward: Number(w.totalReward) }));

  let letter: string | null = null;
  if (m.currentAuctionId !== undefined) {
    const a = conn.db.auction.id.find(m.currentAuctionId);
    if (a && a.status.tag === "Open") letter = a.letter;
  }

  return {
    me: String(myBotId),
    round: m.currentRound,
    auctionsLeft: m.bagTotal,
    auctionType: m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    letter,
    rack,
    players,
    results,
    words,
    startingRack: m.startingRackSize,
  };
}

// ---------- actions ----------

// Bid on the open auction; resends only when the bid goes up (after a word
// raised our balance: cash-then-revise). Never waits for an ack.
function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint) {
  const a = conn.db.auction.id.find(auctionId);
  if (!a || a.status.tag !== "Open") return;
  if (Number(a.closesAt.microsSinceUnixEpoch / 1000n) <= Date.now()) return;
  const rec = records(conn, matchId);
  if (!rec || rec.letter === null) return;
  const ctx = buildCtx(rec) as BidCtx;
  const t0 = performance.now();
  const amount = strategy.decideBid(ctx);
  const ms = performance.now() - t0;
  const prev = bidSent.get(auctionId) ?? 0;
  if (amount <= prev) return;
  bidSent.set(auctionId, amount);
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(matchId, `bid on auction ${auctionId}`));
  log(matchId, {
    event: "bid",
    auctionId,
    round: ctx.round,
    letter: ctx.letter,
    amount,
    revised: prev > 0,
    balance: ctx.balance,
    rack: [...ctx.rackMap].map(([c, n]) => c.repeat(n)).join(""),
    ms: Math.round(ms),
  });
  console.log(
    `[${BOT_NAME}] r${ctx.round} bid ${amount}${prev > 0 ? " (revised)" : ""} on '${ctx.letter}' (bal ${ctx.balance}, ${Math.round(ms)}ms)`,
  );
}

function runningMatches(conn: DbConnection): bigint[] {
  if (myBotId === null) return [];
  const out: bigint[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") out.push(p.matchId);
  }
  return out;
}

// Rack updates for a play arrive one tile at a time; re-planning on a half
// updated rack resends tiles that are already spent. Wait this long after a
// play, then plan once more.
const SETTLE_MS = 350;
const lastPlayAt = new Map<bigint, number>();

function tryPlayWords(conn: DbConnection) {
  for (const matchId of runningMatches(conn)) {
    const since = Date.now() - (lastPlayAt.get(matchId) ?? 0);
    if (since < SETTLE_MS) continue;
    const rec = records(conn, matchId);
    if (!rec) continue;
    const ctx = buildCtx(rec);
    // One decision per rack per auction: the same rack in a later auction
    // can deserve a different answer (endgame).
    const sig = `${ctx.round}:${[...ctx.rack].join(",")}:${ctx.balance}`;
    if (wordsSentFor.get(matchId) === sig) continue;
    wordsSentFor.set(matchId, sig);
    const words = strategy.chooseWords(ctx);
    if (words.length > 0) {
      lastPlayAt.set(matchId, Date.now());
      setTimeout(() => tryPlayWords(conn), SETTLE_MS + 10);
    }
    for (const word of words) {
      console.log(`[${BOT_NAME}] match ${matchId} r${ctx.round}: playing '${word}'`);
      log(matchId, { event: "word", round: ctx.round, word });
      conn.reducers
        .submitWord({ matchId, word })
        .catch(logFailure(matchId, `playing '${word}'`));
    }
  }
}

// Subscribe to one match's rows, once per match we're seated in.
const matchSubs = new Set<bigint>();
function watchMatch(conn: DbConnection, matchId: bigint) {
  if (matchSubs.has(matchId)) return;
  matchSubs.add(matchId);
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      for (const a of conn.db.auction.iter()) {
        if (a.matchId === matchId && a.status.tag === "Open") tryBid(conn, a.id, a.matchId);
      }
      tryPlayWords(conn);
    })
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${matchId}`,
      `SELECT * FROM match_participant WHERE match_id = ${matchId}`,
      `SELECT * FROM auction WHERE match_id = ${matchId}`,
      `SELECT * FROM auction_result WHERE match_id = ${matchId}`,
      `SELECT * FROM word_play WHERE match_id = ${matchId}`,
    ]);
}

// Set once the seats subscription is applied, so its initial rows (past
// matches) don't each open a match subscription. Their insert callbacks can
// fire after onApplied, so new seats must also be later than seatsBase.
let seatsReady = false;
let seatsBase = -1n;

// Our seats in every match. A bot plays one match at a time, so only the
// latest can still be running: watch that one, then the lobby.
function watchOwnSeats(conn: DbConnection) {
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      seatsReady = true;
      let latest: bigint | undefined;
      for (const p of conn.db.matchParticipant.iter()) {
        if (p.botId === myBotId && (latest === undefined || p.matchId > latest)) latest = p.matchId;
      }
      if (latest !== undefined) {
        seatsBase = latest;
        watchMatch(conn, latest);
      }
      bootstrapActivity(conn);
    })
    .subscribe(`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`);
}

// Seated in a watched match that is running, or whose rows haven't arrived yet.
function busy(conn: DbConnection): boolean {
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId || !matchSubs.has(p.matchId)) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (!m || m.status.tag === "Running") return true;
  }
  return false;
}

// joinLobby is a no-op on the server when we're already in the open lobby,
// so just call it whenever we're not in a match.
let lobbyLogged = false;
function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  if (busy(conn)) return;
  if (!lobbyLogged) console.log(`[${BOT_NAME}] joining lobby`);
  lobbyLogged = true;
  conn.reducers.joinLobby({}).catch((err: unknown) =>
    console.warn(`[${BOT_NAME}] joining the lobby failed: ${err instanceof Error ? err.message : err}`),
  );
}

let lobbyWatchdog: ReturnType<typeof setInterval> | undefined;

// AUTO_TOURNAMENT=1: register for any tournament that opens for sign-ups.
// Only one tournament exists at a time, and registering is idempotent.
const AUTO_TOURNAMENT = process.env.AUTO_TOURNAMENT === "1";
const registered = new Set<bigint>();
function registerIfOpen(conn: DbConnection, t: { id: bigint; status: { tag: string } }) {
  if (t.status.tag !== "Registration" || registered.has(t.id)) return;
  registered.add(t.id);
  conn.reducers
    .registerForTournament({ tournamentId: t.id })
    .then(() => console.log(`[${BOT_NAME}] registered for tournament ${t.id}`))
    .catch((err: unknown) => {
      registered.delete(t.id);
      console.warn(`[${BOT_NAME}] tournament ${t.id} registration failed: ${err instanceof Error ? err.message : err}`);
    });
}
function watchTournaments(conn: DbConnection) {
  if (!AUTO_TOURNAMENT) return;
  conn.db.tournament.onInsert((_ctx, t) => registerIfOpen(conn, t));
  conn.db.tournament.onUpdate((_ctx, _old, t) => registerIfOpen(conn, t));
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] watching for tournament registration`);
      for (const t of conn.db.tournament.iter()) registerIfOpen(conn, t);
    })
    .subscribe("SELECT * FROM tournament");
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`))
      .catch((err: unknown) =>
        console.warn(`[${BOT_NAME}] tournament registration failed: ${err instanceof Error ? err.message : err}`),
      );
  }
  joinLobby(conn);
  // A join can be lost without an error, and a bot outside both a match and
  // the open lobby never plays again, so keep checking. In a tournament the
  // server refuses joins until we're knocked out, so check less often.
  clearInterval(lobbyWatchdog);
  lobbyWatchdog = setInterval(() => joinLobby(conn), TOURNAMENT_ID ? 30000 : 5000);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId);
  }
  tryPlayWords(conn);
}

// ---------- connection ----------

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  reconnectDelay = 1000;
  matchSubs.clear(); // a new connection starts with an empty cache
  seatsReady = false;
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE && !claimedNonce) {
          claimedNonce = true;
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch((err: unknown) => console.warn(`claim failed: ${err}`));
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(`[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`);
              process.exit(1);
            }
            watchOwnSeats(conn);
            watchTournaments(conn);
          }, 1000);
          return;
        }
        console.error(
          `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
        );
        process.exit(1);
      }
      const bot = conn.db.bot.id.find(myBotId);
      console.log(`[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
      watchOwnSeats(conn);
      watchTournaments(conn);
    })
    // Not subscribeToAllTables: that streams every match on the server
    // (millions of rows) and the client falls minutes behind. Small tables
    // here; our matches once we know our bot id.
    .subscribe(["SELECT * FROM bot_credential", "SELECT * FROM bot", "SELECT * FROM my_rack"]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag !== "Open") return;
    tryBid(conn, a.id, a.matchId);
    tryPlayWords(conn); // endgame and cash decisions depend on the letter
  });
  conn.db.myRack.onInsert(() => tryPlayWords(conn));
  conn.db.myRack.onUpdate(() => tryPlayWords(conn));
  conn.db.myRack.onDelete(() => tryPlayWords(conn));
  // Our balance changed (a word paid out): revise the open bid upwards.
  conn.db.matchParticipant.onUpdate((_ctx, _old, neu) => {
    if (myBotId === null || neu.botId !== myBotId) return;
    const m = conn.db.matchState.id.find(neu.matchId);
    if (m?.status.tag === "Running" && m.currentAuctionId !== undefined) {
      tryBid(conn, m.currentAuctionId, neu.matchId);
    }
  });
  // Seated in a new match (lobby resolved, or a tournament round).
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (!seatsReady || myBotId === null || p.botId !== myBotId || matchSubs.has(p.matchId)) return;
    if (p.matchId <= seatsBase) return;
    console.log(`[${BOT_NAME}] seated in match ${p.matchId}`);
    lobbyLogged = false;
    watchMatch(conn, p.matchId);
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    if (!runningMatches(conn).includes(r.matchId)) return;
    log(r.matchId, {
      event: "result",
      auctionId: r.auctionId,
      letter: r.letter,
      winner: r.winnerBotId ?? null,
      paid: r.paid,
      won: r.winnerBotId === myBotId,
    });
  });
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const me = Array.from(conn.db.matchParticipant.iter()).find(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (me) {
        const all = Array.from(conn.db.matchParticipant.iter()).filter((p) => p.matchId === neu.id);
        const place = 1 + all.filter((p) => p.score > me.score).length;
        const left = Array.from(conn.db.myRack.iter()).filter((h) => h.matchId === neu.id);
        log(neu.id, {
          event: "end",
          score: me.score,
          balance: me.balance,
          place,
          leftover: left.map((h) => h.letter.repeat(h.count)).join(""),
        });
        console.log(`[${BOT_NAME}] match ${neu.id} ended: score ${me.score}, place ${place}; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

// An offline bot keeps its tournament seat and loses every auction, so
// always come back.
let reconnectDelay = 1000;
function scheduleReconnect() {
  const d = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  console.log(`[${BOT_NAME}] reconnecting in ${d}ms`);
  setTimeout(connect, d);
}

function connect() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error("connect error:", err.message);
      scheduleReconnect();
    })
    .onDisconnect(() => {
      console.log("disconnected");
      clearInterval(lobbyWatchdog);
      scheduleReconnect();
    })
    .build();
}

process.on("uncaughtException", (err) => console.error(`[${BOT_NAME}] uncaught:`, err));
process.on("unhandledRejection", (err) => console.error(`[${BOT_NAME}] unhandled:`, err));

connect();
