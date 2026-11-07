// Runs matches on a pool of worker threads (or in-process with one worker).
// Jobs go out one at a time to whichever worker is free, so slow tables
// don't hold up fast ones. Each worker keeps its agents between jobs, so
// forks and dictionaries load once per worker, not once per match.

import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { runMatch, type Agent, type MatchResult } from "./engine.js";
import { makeAgent } from "./opponents/index.js";

export interface Job {
  id: number;
  table: string[]; // agent spec per seat
  seed: number;
  firstPrice?: boolean;
}

export type SeatResult = MatchResult["seats"][number] & { spec: string; seat: number };
export interface JobResult {
  id: number;
  seed: number;
  seats: SeatResult[];
}

// spec -> instances; a table with the same spec twice gets two instances,
// since agents keep per-match state.
const agents = new Map<string, Agent[]>();

export async function runJob(job: Job): Promise<JobResult> {
  const used = new Map<string, number>();
  const table: Agent[] = [];
  for (const spec of job.table) {
    const k = used.get(spec) ?? 0;
    used.set(spec, k + 1);
    let list = agents.get(spec);
    if (!list) agents.set(spec, (list = []));
    while (list.length <= k) list.push(await makeAgent(spec));
    table.push(list[k]!);
  }
  const res = runMatch(table, {
    seed: job.seed,
    auctionType: job.firstPrice ? "FirstPrice" : "Vickrey",
  });
  return {
    id: job.id,
    seed: job.seed,
    seats: res.seats.map((s, seat) => ({ ...s, spec: job.table[seat]!, seat, firstError: s.firstError?.slice(0, 400) })),
  };
}

export function defaultWorkers(): number {
  return Number(process.env.SIM_WORKERS ?? os.availableParallelism?.() ?? os.cpus().length);
}

export class Pool {
  private workers: Worker[] = [];
  constructor(readonly size = defaultWorkers()) {}

  private spawn(): Worker {
    return new Worker(new URL("./worker.mjs", import.meta.url));
  }

  async run(jobs: Job[], onResult?: (r: JobResult, done: number) => void): Promise<JobResult[]> {
    const out: JobResult[] = [];
    let next = 0;
    const take = () => (next < jobs.length ? jobs[next++]! : undefined);
    const record = (r: JobResult) => {
      out.push(r);
      onResult?.(r, out.length);
    };

    if (this.size <= 1) {
      for (let j = take(); j; j = take()) record(await runJob(j));
      return out;
    }
    while (this.workers.length < Math.min(this.size, jobs.length)) this.workers.push(this.spawn());
    await Promise.all(
      this.workers.slice(0, Math.min(this.size, jobs.length)).map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const feed = () => {
              const j = take();
              if (j) w.postMessage(j);
              else {
                w.off("message", onMsg);
                w.off("error", reject);
                resolve();
              }
            };
            const onMsg = (r: JobResult | { error: string }) => {
              if ("error" in r) return reject(new Error(r.error));
              record(r);
              feed();
            };
            w.on("message", onMsg);
            w.on("error", reject);
            feed();
          }),
      ),
    );
    return out;
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}

// ---------- shared stats ----------

export function meanCI(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { mean, ci: (1.96 * sd) / Math.sqrt(Math.max(1, n)), se: sd / Math.sqrt(Math.max(1, n)) };
}

export function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
}

export function progress(label: string, total: number) {
  const t0 = Date.now();
  return (_r: unknown, done: number) => {
    if (done % 10 === 0 || done === total) {
      const s = (Date.now() - t0) / 1000;
      const eta = done ? (s / done) * (total - done) : 0;
      process.stderr.write(`\r${label} ${done}/${total}  ${s.toFixed(0)}s, eta ${eta.toFixed(0)}s   `);
      if (done === total) process.stderr.write("\n");
    }
  };
}
