// Worker entry for train/pool.ts: register tsx inside the thread so .js
// imports resolve to .ts (same approach as sim/worker.mjs).
import { register } from "tsx/esm/api";
register();
await import("./pool.ts");
