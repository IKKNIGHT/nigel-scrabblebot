// Register the bot for a tournament without restarting the live client.
//   BOT_NAME=N1gel npx tsx scripts/register.ts <tournamentId>
import * as fs from "node:fs";
import { DbConnection } from "../src/module_bindings/index.js";

const name = process.env.BOT_NAME ?? "N1gel";
const id = BigInt(process.argv[2] ?? "0");
const token = fs.readFileSync(`.token-${name}`, "utf8").trim();
const bail = (msg: string, code = 1) => (console.log(msg), process.exit(code));
setTimeout(() => bail("timed out"), 20000);

DbConnection.builder()
  .withUri("https://maincloud.spacetimedb.com")
  .withDatabaseName("scrabblebot")
  .withToken(token)
  .onConnect((conn, identity) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const me = conn.db.botCredential.identity.find(identity)?.botId;
        const t = conn.db.tournament.id.find(id);
        console.log(`bot ${me}; tournament ${id}: ${t ? t.status.tag : "not found"}`);
        const already = [...conn.db.tournamentEntry.iter()].some((e) => e.tournamentId === id && e.botId === me);
        if (already) bail("already registered", 0);
        conn.reducers
          .registerForTournament({ tournamentId: id })
          .then(() => setTimeout(() => {
            const ok = [...conn.db.tournamentEntry.iter()].some((e) => e.tournamentId === id && e.botId === me);
            bail(ok ? "registered" : "reducer ok but no entry row seen yet", ok ? 0 : 2);
          }, 1500))
          .catch((e: unknown) => bail(`registration failed: ${e instanceof Error ? e.message : e}`));
      })
      .subscribe(["SELECT * FROM bot_credential", "SELECT * FROM tournament", `SELECT * FROM tournament_entry WHERE tournament_id = ${id}`]);
  })
  .onConnectError((_c, e) => bail(`connect error: ${e.message}`))
  .build();
