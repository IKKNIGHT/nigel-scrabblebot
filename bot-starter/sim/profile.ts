// Time spent per agent and per call in the sim.
//   npx tsx sim/profile.ts --matches 3 --table nigel,starter,gaucho,afterword,micah,taylor

import { runMatch, type Agent } from "./engine.js";
import { makeAgent } from "./opponents/index.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}

const table = arg("table", "nigel,starter,gaucho,afterword,micah,taylor").split(",");
const matches = Number(arg("matches", "3"));

const t = new Map<string, { bid: number; words: number; bids: number; wordCalls: number; load: number }>();
const timed = async (spec: string): Promise<Agent> => {
  const t0 = performance.now();
  const a = await makeAgent(spec);
  const s = { bid: 0, words: 0, bids: 0, wordCalls: 0, load: performance.now() - t0 };
  t.set(spec, s);
  return {
    ...a,
    decideBid: a.decideBid && ((c) => { const x = performance.now(); try { return a.decideBid!(c); } finally { s.bid += performance.now() - x; s.bids++; } }),
    chooseWords: a.chooseWords && ((c) => { const x = performance.now(); try { return a.chooseWords!(c); } finally { s.words += performance.now() - x; s.wordCalls++; } }),
  };
};

const agents = [];
for (const spec of table) agents.push(await timed(spec));
const t0 = performance.now();
for (let m = 0; m < matches; m++) runMatch(agents, { seed: 1000 + m });
const total = performance.now() - t0;

console.log(`${matches} matches in ${(total / 1000).toFixed(1)}s (${(total / matches).toFixed(0)} ms/match)`);
console.log("agent".padEnd(12) + "load ms".padEnd(10) + "ms/match".padEnd(10) + "share".padEnd(8) + "ms/bid".padEnd(9) + "ms/words");
let agentMs = 0;
for (const [, s] of t) agentMs += s.bid + s.words;
for (const [spec, s] of t) {
  const ms = s.bid + s.words;
  console.log(
    spec.padEnd(12) +
      s.load.toFixed(0).padEnd(10) +
      (ms / matches).toFixed(0).padEnd(10) +
      `${((ms / total) * 100).toFixed(0)}%`.padEnd(8) +
      (s.bid / Math.max(1, s.bids)).toFixed(2).padEnd(9) +
      (s.words / Math.max(1, s.wordCalls)).toFixed(2),
  );
}
console.log(`engine + ctx overhead: ${(((total - agentMs) / total) * 100).toFixed(0)}%`);
