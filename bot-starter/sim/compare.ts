// Paired A/B test of two bots.
//   npx tsx sim/compare.ts --a nigel --b nigel@params.new.json --matches 300
// Options: --pool gaucho,taylor,valor,brutus,cheapo,starter --seed N
//          --first-price --workers N --out file.json
//
// Every match is played twice on the same seed, the same opponents and the
// same seat, once with A and once with B. The bag stream depends only on the
// seed, so both see the same tiles; the per-match difference in place
// cancels most of the luck, and needs far fewer matches than comparing two
// independent averages.

import * as fs from "node:fs";
import { arg, defaultWorkers, meanCI, Pool, progress, type Job, type JobResult } from "./pool.js";
import { Rng } from "./engine.js";

export const DEFAULT_POOL = "gaucho,taylor,valor,brutus,cheapo,starter";

// Five opponents and a seat for match m, fixed by the seed.
export function tableFor(pool: string[], seed: number, m: number, seats = 6) {
  const rng = new Rng((seed ^ Math.imul(m + 1, 0x27d4eb2d)) >>> 0);
  const opponents = Array.from({ length: seats - 1 }, () => pool[rng.int(0, pool.length - 1)]!);
  const seat = m % seats;
  return { opponents, seat };
}

export function withCandidate(opponents: string[], seat: number, spec: string): string[] {
  const t = [...opponents];
  t.splice(seat, 0, spec);
  return t;
}

export interface Paired {
  n: number;
  placeA: number;
  placeB: number;
  diff: ReturnType<typeof meanCI>; // place B − place A (negative = B better)
  scoreDiff: ReturnType<typeof meanCI>;
  winA: number;
  winB: number;
  errors: number;
}

export function pair(a: Map<number, JobResult>, b: Map<number, JobResult>, seats: Map<number, number>): Paired {
  const dPlace: number[] = [];
  const dScore: number[] = [];
  let pa = 0, pb = 0, wa = 0, wb = 0, errors = 0;
  for (const [m, ra] of a) {
    const rb = b.get(m);
    if (!rb) continue;
    const s = seats.get(m)!;
    const A = ra.seats[s]!, B = rb.seats[s]!;
    dPlace.push(B.place - A.place);
    dScore.push(B.score - A.score);
    pa += A.place; pb += B.place;
    wa += A.place === 1 ? 1 : 0; wb += B.place === 1 ? 1 : 0;
    errors += A.errors + B.errors;
  }
  const n = dPlace.length || 1;
  return { n: dPlace.length, placeA: pa / n, placeB: pb / n, diff: meanCI(dPlace), scoreDiff: meanCI(dScore), winA: wa / n, winB: wb / n, errors };
}

async function main() {
  const a = arg("a", "nigel")!;
  const b = arg("b")!;
  if (!b) throw new Error("--b <spec> is required");
  const matches = Number(arg("matches", "300"));
  const pool = arg("pool", DEFAULT_POOL)!.split(",");
  const seed = Number(arg("seed", "4242"));
  const firstPrice = arg("first-price") === "true";
  const workers = Math.max(1, Number(arg("workers", String(defaultWorkers()))));
  const t0 = Date.now();

  const jobs: Job[] = [];
  const seats = new Map<number, number>();
  for (let m = 0; m < matches; m++) {
    const { opponents, seat } = tableFor(pool, seed, m);
    seats.set(m, seat);
    const s = seed + m * 7919;
    jobs.push({ id: 2 * m, table: withCandidate(opponents, seat, a), seed: s, firstPrice });
    jobs.push({ id: 2 * m + 1, table: withCandidate(opponents, seat, b), seed: s, firstPrice });
  }
  const p = new Pool(workers);
  const res = await p.run(jobs, progress("matches", jobs.length));
  await p.close();

  const ra = new Map<number, JobResult>(), rb = new Map<number, JobResult>();
  for (const r of res) (r.id % 2 === 0 ? ra : rb).set(r.id >> 1, r);
  const r = pair(ra, rb, seats);
  const verdict =
    r.diff.mean + r.diff.ci < 0 ? "B is better" : r.diff.mean - r.diff.ci > 0 ? "A is better" : "no significant difference";

  console.log(`${r.n} paired matches, pool ${pool.join(",")}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`A ${a}: avg place ${r.placeA.toFixed(2)}, win ${(r.winA * 100).toFixed(1)}%`);
  console.log(`B ${b}: avg place ${r.placeB.toFixed(2)}, win ${(r.winB * 100).toFixed(1)}%`);
  console.log(`place B−A: ${r.diff.mean.toFixed(3)} ±${r.diff.ci.toFixed(3)}   score B−A: ${r.scoreDiff.mean.toFixed(1)} ±${r.scoreDiff.ci.toFixed(1)}`);
  console.log(`verdict: ${verdict}${r.errors ? `  (${r.errors} agent errors)` : ""}`);
  const out = arg("out");
  if (out) fs.writeFileSync(out, JSON.stringify({ a, b, pool, seed, ...r, verdict }, null, 2));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("sim/compare.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
