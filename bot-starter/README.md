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

## Strategy

Rating and tournament points come from finishing place, so Nigel is tuned
for average place, not raw score. Top public bots score most of their points
from 7+ letter words (the 3× multiplier), so the plan is to build toward
long words, then cash them.

**Rack valuation and target words.** Nigel tracks the unseen tiles (bag
minus everything won) and estimates, for each letter, the chance of winning
1, 2 or 3 more copies before the match ends (Poisson, scaled by `pWin`). The
value of a rack is the best *target word* reachable from it: its reward,
weighted by the chance of getting the missing tiles, minus their expected
price from public auction history (`data/price_table.json`, per letter and
match phase). A share of the best second target from the leftover tiles is
added (`w2`). A letter's value is how much it raises the rack value. In the
last `endN` auctions it switches to the exact best split of the rack into
playable words.

**Bidding (Vickrey).** Under second-price, bidding true value is the safe
default, so the bid is `alpha × value gain + beta × face value + gamma +
pace × (balance / auctions left)`. Letters that add nothing get a reduced
face weight. Around that:
- *Caps:* early on at most `capBase` of the balance goes on one tile, and
  the cap opens to 100% by the end (`capPow`), so an early bidding war can't
  drain the stake.
- *Pace floor:* if Nigel is behind its tile target (`letterTarget` per
  match), useful letters are bid at least `floorMult ×` the typical winning
  bid for that letter and phase.
- *Q without U or I* is discounted (`qW`).
- *First-price* tournaments: the bid is shaded (`shade`).
- The bid is sent the moment an auction opens and then revised, so the 1 s
  window is never missed.

**Hold vs play.** Any 7+ letter word is played at once: its multiplier
can't grow, and the coins fund later bids. A shorter word is played only if
its reward is at least `minPlayReward` and the reward plus the value of the
leftover rack is at least `holdKappa` of the rack's current value. Nigel also
cashes a word when it's short of coins (`lowCash`), when a word lets it
afford a letter worth clearly more than its balance (`cashRevise`, then it
revises the bid), or when the rack grows past `holdMax`.

**Endgame.** Leftover coins and tiles are worth 0. The last tile can never
be played, so Nigel bids 0 on auction #68 and may go all in on the last
playable tile if it scores. In the last auctions it values letters by the
exact best split of the rack, so the rack is emptied before the close.

**Sim and tuning.** `sim/engine.ts` mirrors the server rules (Vickrey and
first-price) with seeded tile order. The opponent pool has the server's sim
bots, public forks and proxies of the top live bots (`bron`, `lucent`,
`maverick`), fitted from public auction history in `train/`. A change is
kept only if a paired `compare` (same seed, seat and opponents for both
versions) over 300+ matches shows a place gain whose 95% CI doesn't cross 0.
`evolve` mutates the params within `params.bounds.json` and accepts a
mutant by the same test. One opponent is kept out of tuning as a check for
overfitting.

**Results** (300 paired matches each, place B−A < 0 is better for B):

| A → B | Opponents | Avg place A → B | Place B−A | Score B−A |
|---|---|---|---|---|
| hand-set → evolve gens 1–2 | bron, lucent, maverick, brutus, valor, cheapo | 1.79 → 1.65 | −0.147 ±0.107 | +8.3 ±3.5 |
| hand-set → evolve gens 1–2 | cheapo, valor, brutus | 1.00 → 1.00 | 0 | +28.4 ±3.0 |

Evolve log: `results/2026-11-07-evolve.md` (gen 1 −0.46 ±0.18, gen 2
−0.17 ±0.18 over 150 matches each).

## Credits

- Clockwork Labs' `scrabblebot` (MIT): the bot starter (connection and lobby
  flow in `src/index.ts`), the rules in `src/rules.ts` and `sim/engine.ts`,
  and the dictionary code in `sim/dictionary.ts` are taken from it.
- Ideas from public forks: gaucho (JoaquinGiorgis), whose reward-sorted typed
  dictionary and "unseen tiles" view informed `words.ts` and `view.ts`, and
  afterword (Jose-Gael-Cruz-Lopez), whose public-history planning context
  informed `BidCtx`. Both forks, plus micahlai and Phaslyr, are sim opponents only.
