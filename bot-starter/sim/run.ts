// Sim runner.
//   npm run sim -- --matches 500 --table nigel,gaucho,afterword,valor,brutus,cheapo
// Options: --seed N, --first-price, --workers N, --no-rotate, --out file.json
// Seats rotate every match so no bot keeps a seat. Prints average place
// (primary), win rate and mean score per bot with 95% confidence intervals.

import * as fs from "node:fs";
import { arg, defaultWorkers, meanCI, Pool, progress, type Job, type SeatResult } from "./pool.js";

async function main() {
  const matches = Number(arg("matches", "100"));
  const table = (arg("table", "nigel,starter,valor,brutus,cheapo,cheapo") ?? "").split(",").filter(Boolean);
  const seed = Number(arg("seed", "12345"));
  const firstPrice = arg("first-price") === "true";
  const rotate = arg("no-rotate") !== "true";
  const workers = Math.max(1, Math.min(Number(arg("workers", String(defaultWorkers()))), matches));
  const out = arg("out");
  const t0 = Date.now();

  // Entries with the same spec are told apart by position in --table.
  const labels = table.map((t, i) =>
    table.filter((x) => x === t).length > 1 ? `${t}#${table.slice(0, i + 1).filter((x) => x === t).length}` : t,
  );
  const orders: number[][] = [];
  const jobs: Job[] = [];
  for (let m = 0; m < matches; m++) {
    const shift = rotate ? m % table.length : 0;
    const order = table.map((_, i) => (i + shift) % table.length);
    orders.push(order);
    jobs.push({ id: m, table: order.map((i) => table[i]!), seed: seed + m * 7919, firstPrice });
  }

  const pool = new Pool(workers);
  const results = await pool.run(jobs, progress("matches", matches));
  await pool.close();

  const rows: (SeatResult & { label: string })[] = [];
  for (const r of results) {
    r.seats.forEach((s, seat) => rows.push({ ...s, label: labels[orders[r.id]![seat]!]! }));
  }

  const report = labels.map((label) => {
    const rs = rows.filter((r) => r.label === label);
    const place = meanCI(rs.map((r) => r.place));
    const win = meanCI(rs.map((r) => (r.place === 1 ? 1 : 0)));
    const score = meanCI(rs.map((r) => r.score));
    const totalScore = rs.reduce((a, r) => a + r.score, 0);
    return {
      bot: label,
      n: rs.length,
      avgPlace: place.mean,
      placeCI: place.ci,
      winRate: win.mean,
      winCI: win.ci,
      meanScore: score.mean,
      scoreCI: score.ci,
      longShare: totalScore > 0 ? rs.reduce((a, r) => a + r.longPoints, 0) / totalScore : 0,
      leftover: rs.reduce((a, r) => a + r.leftover, 0) / rs.length,
      rejectedBids: rs.reduce((a, r) => a + r.rejectedBids, 0),
      invalidWords: rs.reduce((a, r) => a + r.invalidWords, 0),
      errors: rs.reduce((a, r) => a + r.errors, 0),
      firstError: rs.find((r) => r.firstError)?.firstError,
    };
  });
  report.sort((a, b) => a.avgPlace - b.avgPlace);

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `${matches} matches, ${firstPrice ? "first-price" : "Vickrey"}, seed ${seed}, ${workers} workers, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(pad("bot", 14) + pad("avg place", 16) + pad("win rate", 16) + pad("mean score", 18) + pad("7+ share", 10) + pad("leftover", 10) + "rejected/invalid/errors");
  for (const r of report) {
    console.log(
      pad(r.bot, 14) +
        pad(`${r.avgPlace.toFixed(2)} ±${r.placeCI.toFixed(2)}`, 16) +
        pad(`${(r.winRate * 100).toFixed(1)}% ±${(r.winCI * 100).toFixed(1)}`, 16) +
        pad(`${r.meanScore.toFixed(1)} ±${r.scoreCI.toFixed(1)}`, 18) +
        pad(`${(r.longShare * 100).toFixed(0)}%`, 10) +
        pad(r.leftover.toFixed(2), 10) +
        `${r.rejectedBids}/${r.invalidWords}/${r.errors}`,
    );
  }
  for (const r of report) {
    if (r.firstError) console.error(`\n${r.bot} threw:\n${r.firstError.split("\n").slice(0, 4).join("\n")}`);
  }
  if (out) fs.writeFileSync(out, JSON.stringify({ matches, table, seed, firstPrice, report }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
