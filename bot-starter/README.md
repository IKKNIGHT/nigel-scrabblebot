# Nigel

ScrabbleBot for HackUTD 2026 (Spacetime track), built on the official
bot starter.

## Run

```bash
npm install
npm run bindings              # copies generated bindings from ../src/module_bindings
BOT_NAME=nigel BOT_TOKEN=<token from /team> npm start   # first run
BOT_NAME=nigel npm start                                # later runs
BOT_NAME=nigel TOURNAMENT_ID=<id> npm start             # tournament
```

Logs: `logs/<matchId>.jsonl` (every bid, word, result and the final place).

## Sim

```bash
bash scripts/pull_public.sh                 # recent public tables -> data/
npx tsx scripts/build_price_table.ts        # data/price_table.json
npm run sim -- --matches 500 --table nigel,gaucho,afterword,valor,brutus,cheapo
```

Opponents: `cheapo`, `valor` and `brutus` are the server's sim bots
(Cheapskate, ValueBidder, Aggressive). `starter` is the official starter.
`nigel@path/params.json` is Nigel with saved params. `gaucho`, `afterword`,
`micah` and `taylor` are public forks, loaded at test time from `FORKS_DIR`
(default `../../forks`). They are never imported by the live bot.
`bron`, `lucent` and `maverick` are proxies of top live bots fitted from
public history (`train/`), so they are approximate.

Flags: `--seed`, `--first-price`, `--workers`, `--no-rotate`, `--out`.

```bash
npm run compare -- --a nigel --b nigel@params.new.json --matches 300   # paired A/B
npm run evolve -- --generations 20 --mutants 8 --matches 150           # tune params
npm run profile -- --matches 3 --table nigel,gaucho,afterword,micah,taylor,starter
```

`compare` plays every match twice on the same seed, opponents and seat, once
per version, and reports the per-match difference in place. The tile order
depends only on the seed, so most of the luck cancels.
`evolve` mutates params, scores mutants the same way (successive halving,
one-sided 95% acceptance), and writes `results/evolve-best.json` and
`results/<date>-evolve.md`. It never overwrites `params.json`. Ranges come
from `params.bounds.json`; keys without a range are
listed and left fixed. The default tuning pool is
gaucho,taylor,valor,brutus,cheapo,starter (about 1 s per match per core).
afterword is held out and micah is left out: they take 4 s and 2 s per match.

Cloud (Colab or any Linux box): `bash sim/colab.sh` installs Node 20, the
forks and deps; every run then uses all cores (`SIM_WORKERS` overrides).
The sim is CPU-bound, so pick a runtime with many vCPUs. The GPU isn't used.

## Layout

| Path | What |
|---|---|
| `src/rules.ts` | Letter values, bag, multipliers, sim-bot bid rule (from the server) |
| `src/words.ts` | Compiled dictionary, fit test, best split, target-word potential |
| `src/view.ts` | `BidCtx`/`WordCtx` from public tables: bag tracking, rival racks |
| `src/strategy.ts` | `decideBid`, `chooseWords`; settings in `params.json` |
| `src/index.ts` | Live client: quick bid then revise, JSONL logs, auto-reconnect |
| `sim/engine.ts` | Rules engine mirroring `spacetimedb/src/game.ts`, seeded |
| `sim/dictionary.ts` | The server's dictionary code, for validation and sim-bot play |
| `sim/opponents/` | Opponent pool and fork adapters |
| `sim/run.ts` | Runner: average place, win rate, mean score with 95% CIs |
| `sim/pool.ts`, `sim/worker.*` | Worker-thread pool with a job queue; agents cached per worker |
| `sim/compare.ts`, `sim/evolve.ts` | Paired A/B test; evolutionary params search |

## Credits

- Clockwork Labs' `scrabblebot` (MIT): the bot starter (connection and lobby
  flow in `src/index.ts`), the rules in `src/rules.ts` and `sim/engine.ts`,
  and the dictionary code in `sim/dictionary.ts` are taken from it.
- Ideas from public forks: gaucho (JoaquinGiorgis), whose reward-sorted typed
  dictionary and "unseen tiles" view informed `words.ts` and `view.ts`, and
  afterword (Jose-Gael-Cruz-Lopez), whose public-history planning context
  informed `BidCtx`. Both forks, plus micahlai and Phaslyr, are sim opponents only.
