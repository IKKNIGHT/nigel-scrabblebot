// Worker thread for sim/pool.ts: runs one match per message.

import { parentPort } from "node:worker_threads";
import { runJob, type Job } from "./pool.js";

parentPort!.on("message", (job: Job) => {
  runJob(job).then(
    (r) => parentPort!.postMessage(r),
    (e) => parentPort!.postMessage({ error: e instanceof Error ? e.stack ?? e.message : String(e) }),
  );
});
