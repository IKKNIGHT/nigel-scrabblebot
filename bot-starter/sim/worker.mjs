// Worker entry: register tsx inside the thread (Node would otherwise run
// worker.ts with its own type stripping and no .js -> .ts resolution).
import { register } from "tsx/esm/api";
register();
await import("./worker.ts");
