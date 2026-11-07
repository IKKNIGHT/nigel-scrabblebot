// Evaluate Nigel (params.json, or --params file) against training tables.
//   npx tsx train/eval.ts --matches 200 [--params f.json] [--vs other.json]
//     [--tables "bron,lucent,maverick,brutus,valor;bron,gaucho,cheapo,valor,brutus"]
// With --vs, both param sets play the same seeds and the paired difference
// in Nigel's place is printed.

import * as fs from "node:fs";
import { Pool, pairedPlace, printSummary } from "./pool.js";

export const TRAIN_TABLES = [
  ["bron", "lucent", "maverick", "brutus", "valor"],
  ["bron", "gaucho", "brutus", "valor", "cheapo"],
  ["bron", "maverick", "gaucho", "brutus", "cheapo"],
  ["bron", "lucent", "brutus", "valor", "cheapo"],
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const readParams = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

async function main() {
  const matches = Number(arg("matches") ?? 100);
  const tables = arg("tables")?.split(";").map((t) => t.split(",")) ?? TRAIN_TABLES;
  const params = readParams(arg("params") ?? "params.json");
  const seedBase = Number(arg("seed") ?? 900000);
  const seeds = Array.from({ length: matches }, (_, i) => seedBase + i);
  const pool = new Pool(Number(arg("workers") ?? 0) || undefined);
  const t0 = Date.now();
  const rows = await pool.run({ params, tables, seeds, firstPrice: arg("first-price") === "true" });
  console.log(`${matches} matches in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  printSummary(rows);
  const vs = arg("vs");
  if (vs) {
    const other = await pool.run({ params: readParams(vs), tables, seeds });
    console.log(`\n--vs ${vs}:`);
    printSummary(other);
    const d = pairedPlace(rows, other);
    console.log(`\nplace(${vs}) - place(this) = ${d.mean.toFixed(3)} ±${d.ci.toFixed(3)}`);
  }
  pool.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
