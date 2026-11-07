// Evaluation of Nigel param sets on a fixed set of seeds and tables, spread
// over worker threads. Seeds are shared between candidates (common random
// numbers), so two param sets are compared on the same tiles.

import * as os from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { Params } from "../src/strategy.js";
import { runMatch, type Agent } from "../sim/engine.js";
import { agentFor, nigelAgent } from "./agents.js";

export interface EvalJob {
  params: Partial<Params>;
  tables: string[][]; // opponents for each table (5 each); match m uses tables[m % n]
  seeds: number[];
  firstPrice?: boolean;
}
export interface MatchRow {
  seed: number;
  table: number;
  bots: { name: string; score: number; place: number; wins: number }[]; // [0] is Nigel
}

// ---------- worker side ----------

const cache = new Map<string, Agent>();
async function opponent(spec: string, slot: number): Promise<Agent> {
  // One instance per spec and slot, so duplicate specs keep separate state.
  const key = `${spec}#${slot}`;
  let a = cache.get(key);
  if (!a) {
    a = await agentFor(spec);
    cache.set(key, a);
  }
  return a;
}

async function runJob(job: EvalJob): Promise<MatchRow[]> {
  const nigel = nigelAgent("nigel", job.params);
  const rows: MatchRow[] = [];
  for (const seed of job.seeds) {
    const t = seed % job.tables.length;
    const table = job.tables[t]!;
    const opps = await Promise.all(table.map((s, i) => opponent(s, i)));
    const lineup = [nigel, ...opps];
    // Rotate seats by seed so Nigel isn't always first to act.
    const shift = seed % lineup.length;
    const order = lineup.map((_, i) => (i + shift) % lineup.length);
    const res = runMatch(order.map((i) => lineup[i]!), {
      seed,
      auctionType: job.firstPrice ? "FirstPrice" : "Vickrey",
    });
    const wins = new Map<string, number>();
    for (const r of res.results) if (r.winner) wins.set(r.winner, (wins.get(r.winner) ?? 0) + 1);
    const bots = order.map((orig, seat) => ({
      orig,
      name: orig === 0 ? "nigel" : table[orig - 1]!,
      score: res.seats[seat]!.score,
      place: res.seats[seat]!.place,
      wins: wins.get(`s${seat}`) ?? 0,
    }));
    bots.sort((a, b) => a.orig - b.orig);
    rows.push({ seed, table: t, bots: bots.map(({ orig: _o, ...b }) => b) });
  }
  return rows;
}

if (!isMainThread && workerData?.evalWorker) {
  parentPort!.on("message", async (job: EvalJob) => {
    try {
      parentPort!.postMessage({ ok: await runJob(job) });
    } catch (e) {
      parentPort!.postMessage({ err: e instanceof Error ? e.stack : String(e) });
    }
  });
}

// ---------- main side ----------

export class Pool {
  private workers: Worker[] = [];
  constructor(n = Math.max(1, os.cpus().length)) {
    for (let i = 0; i < n; i++) {
      this.workers.push(
        new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { evalWorker: true } }),
      );
    }
  }
  get size() {
    return this.workers.length;
  }
  // Runs the seeds split across workers; rows come back in seed order.
  async run(job: EvalJob): Promise<MatchRow[]> {
    const n = this.workers.length;
    const chunks = this.workers.map((_, w) => job.seeds.filter((_, i) => i % n === w));
    const parts = await Promise.all(
      this.workers.map(
        (worker, w) =>
          new Promise<MatchRow[]>((resolve, reject) => {
            if (chunks[w]!.length === 0) return resolve([]);
            worker.once("message", (m: { ok?: MatchRow[]; err?: string }) =>
              m.ok ? resolve(m.ok) : reject(new Error(m.err)),
            );
            worker.postMessage({ ...job, seeds: chunks[w] });
          }),
      ),
    );
    const bySeed = new Map(parts.flat().map((r) => [r.seed, r]));
    return job.seeds.map((s) => bySeed.get(s)!);
  }
  close() {
    for (const w of this.workers) void w.terminate();
  }
}

export function summarize(rows: MatchRow[]) {
  const names = [...new Set(rows.flatMap((r) => r.bots.map((b) => b.name)))];
  return names.map((name) => {
    const bs = rows.flatMap((r) => r.bots.filter((b) => b.name === name));
    const n = bs.length;
    const mean = (f: (b: (typeof bs)[0]) => number) => bs.reduce((a, b) => a + f(b), 0) / Math.max(1, n);
    const place = mean((b) => b.place);
    const sd = Math.sqrt(bs.reduce((a, b) => a + (b.place - place) ** 2, 0) / Math.max(1, n - 1));
    return {
      name,
      n,
      place,
      placeCI: (1.96 * sd) / Math.sqrt(Math.max(1, n)),
      win: mean((b) => (b.place === 1 ? 1 : 0)),
      score: mean((b) => b.score),
      wins: mean((b) => b.wins),
    };
  });
}

// Paired difference in Nigel's place between two runs on the same seeds:
// negative = `b` places better.
export function pairedPlace(a: MatchRow[], b: MatchRow[]) {
  const d = a.map((r, i) => b[i]!.bots[0]!.place - r.bots[0]!.place);
  const mean = d.reduce((x, y) => x + y, 0) / d.length;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, d.length - 1));
  return { mean, ci: (1.96 * sd) / Math.sqrt(d.length) };
}

export function printSummary(rows: MatchRow[]) {
  console.log("bot".padEnd(12) + "place".padEnd(14) + "win%".padEnd(8) + "score".padEnd(9) + "tiles won");
  for (const s of summarize(rows).sort((a, b) => a.place - b.place)) {
    console.log(
      s.name.padEnd(12) +
        `${s.place.toFixed(2)} ±${s.placeCI.toFixed(2)}`.padEnd(14) +
        `${(s.win * 100).toFixed(0)}%`.padEnd(8) +
        s.score.toFixed(1).padEnd(9) +
        s.wins.toFixed(1),
    );
  }
}
