// Evolutionary search over Nigel's params, scored by paired average place.
//   npx tsx sim/evolve.ts --generations 20 --mutants 8 --matches 150
// Options: --pool (default gaucho,taylor,valor,brutus,cheapo,starter)
//          --holdout afterword  --holdout-matches 200  --start file.json
//          --seed N  --workers N  --bounds extra-ranges.json
//
// Each generation: mutate the current best, score every mutant against it
// on fresh seeds (same seeds, opponents and seat for both: paired), drop the
// worse half after a third of the matches (successive halving), and accept
// the best survivor only if it beats the incumbent at one-sided 95%. The
// incumbent's matches are played once per generation and shared by every
// mutant. The held-out bot is never in the tuning pool; the final check
// plays it.
//
// Tuned keys are the keys of the starting params that have a range in
// params.bounds.json (or --bounds). Output goes to results/:
// evolve-best.json and <date>-evolve.md. params.json is never overwritten.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POOL, pair, tableFor, withCandidate } from "./compare.js";
import { Rng } from "./engine.js";
import { arg, defaultWorkers, Pool, progress, type Job, type JobResult } from "./pool.js";

type Params = Record<string, number>;
type Bound = [number, number, "int"?];

const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(BOT_DIR, "results");

const spec = (p: Params) => `nigel@${JSON.stringify(p)}`;

function mutate(p: Params, bounds: Record<string, Bound>, rng: Rng, rate: number, sigma: number): Params {
  const keys = Object.keys(bounds);
  if (keys.length === 0) return { ...p };
  const q = { ...p };
  let changed = false;
  for (const k of keys) {
    if (rng.next() > rate) continue;
    const [lo, hi, kind] = bounds[k]!;
    // Box-Muller
    const g = Math.sqrt(-2 * Math.log(rng.next() || 1e-12)) * Math.cos(2 * Math.PI * rng.next());
    let v = q[k]! + g * sigma * (hi - lo);
    v = Math.min(hi, Math.max(lo, v));
    q[k] = kind === "int" ? Math.round(v) : Number(v.toFixed(3));
    changed ||= q[k] !== p[k];
  }
  if (!changed) return mutate(p, bounds, rng, rate, sigma);
  return q;
}

async function main() {
  const generations = Number(arg("generations", "10"));
  const mutants = Number(arg("mutants", "8"));
  const matches = Number(arg("matches", "150"));
  const pool = arg("pool", DEFAULT_POOL)!.split(",");
  const startFile = arg("start", path.join(BOT_DIR, "params.json"))!;
  const holdout = arg("holdout", "afterword")!;
  const holdoutMatches = Number(arg("holdout-matches", "200"));
  const seed0 = Number(arg("seed", String(Date.now() % 1e6)));
  const workers = Math.max(1, Number(arg("workers", String(defaultWorkers()))));
  // Ranges: params.bounds.json next to the starting params (owned by the
  // strategy), plus --bounds <file> if given.
  const readBounds = (f: string) => (fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, Bound>) : {});
  const allBounds = {
    ...readBounds(arg("bounds", "")!),
    ...readBounds(startFile.replace(/\.json$/, ".bounds.json")),
  };

  if (pool.includes(holdout)) throw new Error(`holdout '${holdout}' is in the tuning pool`);
  const start: Params = JSON.parse(fs.readFileSync(startFile, "utf8"));
  const bounds: Record<string, Bound> = {};
  for (const k of Object.keys(start)) if (allBounds[k] && typeof start[k] === "number") bounds[k] = allBounds[k]!;
  const skipped = Object.keys(start).filter((k) => !bounds[k]);
  console.log(`tuning ${Object.keys(bounds).length} keys: ${Object.keys(bounds).join(", ")}`);
  if (skipped.length) console.warn(`NOT tuned (no range in params.bounds.json): ${skipped.join(", ")}`);
  if (Object.keys(bounds).length === 0) throw new Error("nothing to tune");

  fs.mkdirSync(RESULTS, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const md = path.join(RESULTS, `${date}-evolve.md`);
  fs.appendFileSync(
    md,
    `\n## Evolve run, seed ${seed0}\n\npool ${pool.join(",")}, ${matches} paired matches per mutant, ${mutants} mutants per generation\n\n| gen | best mutant place Δ | accepted |\n|---|---|---|\n`,
  );

  const rng = new Rng(seed0);
  const p = new Pool(workers);
  let best = start;
  const stage1 = Math.max(10, Math.floor(matches / 3));

  for (let g = 0; g < generations; g++) {
    const seed = seed0 + (g + 1) * 1_000_003;
    const tables = Array.from({ length: matches }, (_, m) => tableFor(pool, seed, m));
    const seats = new Map(tables.map((t, m) => [m, t.seat]));
    const jobsFor = (who: string, from: number, to: number, tag: number): Job[] => {
      const out: Job[] = [];
      for (let m = from; m < to; m++) {
        out.push({ id: tag * 1_000_000 + m, table: withCandidate(tables[m]!.opponents, tables[m]!.seat, who), seed: seed + m * 7919 });
      }
      return out;
    };
    const split = (rs: JobResult[]) => {
      const by = new Map<number, Map<number, JobResult>>();
      for (const r of rs) {
        const tag = Math.floor(r.id / 1_000_000);
        if (!by.has(tag)) by.set(tag, new Map());
        by.get(tag)!.set(r.id % 1_000_000, r);
      }
      return by;
    };

    const cands = Array.from({ length: mutants }, () => mutate(best, bounds, rng, 0.35, 0.15));
    // Stage 1: incumbent on every seed (reused), mutants on the first third.
    const jobs1 = [...jobsFor(spec(best), 0, matches, 0), ...cands.flatMap((c, i) => jobsFor(spec(c), 0, stage1, i + 1))];
    const res1 = split(await p.run(jobs1, progress(`gen ${g + 1} stage 1`, jobs1.length)));
    const base = res1.get(0)!;
    const ranked = cands
      .map((c, i) => ({ c, i, r: pair(base, res1.get(i + 1) ?? new Map(), seats) }))
      .sort((x, y) => x.r.diff.mean - y.r.diff.mean || y.r.scoreDiff.mean - x.r.scoreDiff.mean)
      .slice(0, Math.ceil(mutants / 2));

    // Stage 2: survivors on the remaining seeds.
    const jobs2 = ranked.flatMap((x) => jobsFor(spec(x.c), stage1, matches, x.i + 1));
    const res2 = split(await p.run(jobs2, progress(`gen ${g + 1} stage 2`, jobs2.length)));
    const finals = ranked
      .map((x) => {
        const all = new Map([...(res1.get(x.i + 1) ?? []), ...(res2.get(x.i + 1) ?? [])]);
        return { ...x, r: pair(base, all, seats) };
      })
      .sort((x, y) => x.r.diff.mean - y.r.diff.mean || y.r.scoreDiff.mean - x.r.scoreDiff.mean);

    const top = finals[0]!;
    const accepted = top.r.diff.mean + 1.645 * top.r.diff.se < 0;
    const line = `gen ${g + 1}: best mutant place Δ ${top.r.diff.mean.toFixed(3)} ±${top.r.diff.ci.toFixed(3)}, score Δ ${top.r.scoreDiff.mean.toFixed(1)} (n=${top.r.n}) ${accepted ? "ACCEPTED" : "rejected"}`;
    console.log(line);
    fs.appendFileSync(md, `| ${g + 1} | ${top.r.diff.mean.toFixed(3)} ±${top.r.diff.ci.toFixed(3)} | ${accepted ? "yes" : "no"} |\n`);
    if (accepted) {
      const changed = Object.keys(bounds).filter((k) => top.c[k] !== best[k]).map((k) => `${k} ${best[k]}→${top.c[k]}`);
      console.log(`  ${changed.join(", ")}`);
      best = top.c;
      fs.writeFileSync(path.join(RESULTS, "evolve-best.json"), JSON.stringify(best, null, 2) + "\n");
    }
  }

  // Overfitting guard: start vs best on tables that include the held-out
  // bot, and on a table of only sim bots.
  const checks: [string, string[]][] = [
    [`holdout ${holdout}`, [holdout, ...pool]],
    ["sim bots only", ["valor", "brutus", "cheapo"]],
  ];
  fs.appendFileSync(md, `\nfinal params: \`${JSON.stringify(best)}\`\n\n| check | start place | best place | Δ |\n|---|---|---|---|\n`);
  for (const [name, checkPool] of checks) {
    const seed = seed0 + 7;
    const tables = Array.from({ length: holdoutMatches }, (_, m) => {
      const t = tableFor(checkPool, seed, m);
      // Make sure the held-out bot actually sits at the table.
      if (name.startsWith("holdout") && !t.opponents.includes(holdout)) t.opponents[0] = holdout;
      return t;
    });
    const seats = new Map(tables.map((t, m) => [m, t.seat]));
    const jobs: Job[] = [];
    tables.forEach((t, m) => {
      jobs.push({ id: 2 * m, table: withCandidate(t.opponents, t.seat, spec(start)), seed: seed + m * 7919 });
      jobs.push({ id: 2 * m + 1, table: withCandidate(t.opponents, t.seat, spec(best)), seed: seed + m * 7919 });
    });
    const rs = await p.run(jobs, progress(name, jobs.length));
    const a = new Map<number, JobResult>(), b = new Map<number, JobResult>();
    for (const r of rs) (r.id % 2 === 0 ? a : b).set(r.id >> 1, r);
    const r = pair(a, b, seats);
    const line = `${name}: start ${r.placeA.toFixed(2)} → best ${r.placeB.toFixed(2)} (Δ ${r.diff.mean.toFixed(3)} ±${r.diff.ci.toFixed(3)})`;
    console.log(line);
    fs.appendFileSync(md, `| ${name} | ${r.placeA.toFixed(2)} | ${r.placeB.toFixed(2)} | ${r.diff.mean.toFixed(3)} ±${r.diff.ci.toFixed(3)} |\n`);
  }
  await p.close();
  console.log(`best params: results/evolve-best.json; log: ${path.relative(BOT_DIR, md)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
