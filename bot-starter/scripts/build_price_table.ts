// Build data/price_table.json (median clearing price per letter for each
// fifth of the match) and data/top_table.json (median winning bid) from data/auction_result.json, pulled by
// scripts/pull_public.sh. Run: npx tsx scripts/build_price_table.ts

import * as fs from "node:fs";
import { LETTERS } from "../src/rules.js";
import { PHASES } from "../src/strategy.js";

// The SQL endpoint returns [{ schema: { elements: [{ name: { some } }] }, rows }].
export function readTable(file: string): Record<string, unknown>[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const out: Record<string, unknown>[] = [];
  for (const stmt of Array.isArray(raw) ? raw : [raw]) {
    const cols: string[] = stmt.schema.elements.map((e: { name: { some?: string } | string }) =>
      typeof e.name === "string" ? e.name : (e.name.some ?? ""),
    );
    for (const row of stmt.rows) {
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => (o[c] = row[i]));
      out.push(o);
    }
  }
  return out;
}

// Options come back as { some: x } / { none: [] } or [tag, value].
function optional(v: unknown): unknown {
  if (v && typeof v === "object") {
    if ("some" in v) return (v as { some: unknown }).some;
    if ("none" in v) return undefined;
    if (Array.isArray(v)) return v[0] === 0 ? v[1] : undefined;
  }
  return v;
}

function main() {
  const rows = readTable("data/auction_result.json");
  const byMatch = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const m = String(r.match_id);
    if (!byMatch.has(m)) byMatch.set(m, []);
    byMatch.get(m)!.push(r);
  }
  const prices = new Map<string, number[][]>();
  const tops = new Map<string, number[][]>();
  for (const c of LETTERS) {
    prices.set(c, Array.from({ length: PHASES }, () => []));
    tops.set(c, Array.from({ length: PHASES }, () => []));
  }
  const top = new Map<string, number>();
  if (fs.existsSync("data/auction_top_bid_archive.json")) {
    for (const t of readTable("data/auction_top_bid_archive.json")) top.set(String(t.auction_id), Number(t.top_bid));
  }
  for (const auctions of byMatch.values()) {
    auctions.sort((a, b) => Number(a.auction_id) - Number(b.auction_id));
    const total = auctions.length;
    if (total < 60) continue; // unfinished or odd-sized match
    auctions.forEach((a, i) => {
      if (optional(a.winner_bot_id) === undefined) return;
      const phase = Math.min(PHASES - 1, Math.floor((i * PHASES) / total));
      prices.get(String(a.letter))?.[phase]!.push(Number(a.paid));
      const tb = top.get(String(a.auction_id));
      if (tb !== undefined) tops.get(String(a.letter))?.[phase]!.push(tb);
    });
  }
  const median = (xs: number[]) => {
    if (xs.length === 0) return 1;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const table: Record<string, number[]> = {};
  for (const [c, phases] of prices) table[c] = phases.map(median);
  fs.writeFileSync("data/price_table.json", JSON.stringify(table, null, 1));
  // The winning bid: what a bid has to beat.
  const topTable: Record<string, number[]> = {};
  for (const [c, phases] of tops) topTable[c] = phases.map(median);
  fs.writeFileSync("data/top_table.json", JSON.stringify(topTable));
  console.log(`price table from ${byMatch.size} matches written to data/price_table.json`);
}

// Run only as a script, not when imported for readTable.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/build_price_table.ts")) main();
