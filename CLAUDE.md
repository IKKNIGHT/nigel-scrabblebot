# CLAUDE.md — Nigel (HackUTD 2026, Spacetime ScrabbleBot track)

You are picking up **Nigel**, a ScrabbleBot that has to finish ahead of the strongest past bots.
**Deadline: 11 PM CT, Sat Nov 7 2026.** By then the bot must be in a **public GitHub repo** and **running live**.
The goal is **finishing place**, not raw score: OpenSkill rating and tournament Swiss points both come from place.

All our code is in `bot-starter/`. The rest of the repo is upstream `clockworklabs/scrabblebot` (the server, the web app and the docs).
**The server code wins** over the README and docs: `spacetimedb/src/game.ts`, `lobby.ts`, `tournament.ts`.

---

## 0. First thing on a new computer

Follow these steps in order, and tell the user about any step that needs them (the token or GitHub auth).

```bash
# Node 20+ and git are required. Windows: run these in Git Bash (or translate the env-var syntax, see below).
git clone https://github.com/IKKNIGHT/nigel-scrabblebot.git scrabblebot
cd scrabblebot/bot-starter
npm install
npm run bindings          # copies ../src/module_bindings into src/module_bindings (no spacetime CLI needed)
npm test                  # expect 10/10 pass (~15 s)
npm run typecheck         # expect no output
```

Sim opponents from the public forks are read from `FORKS_DIR`, which defaults to `../../forks` (a sibling of the repo folder).
Fetch them once:

```bash
mkdir -p ../../forks && cd ../../forks
for r in JoaquinGiorgis/scrabblebot-gaucho Jose-Gael-Cruz-Lopez/afterword-scrabblebot Phaslyr/scrabblebot micahlai/scrabblebot; do
  d="$(echo $r | tr / _)"; [ -d "$d" ] || git clone -q --depth 1 https://github.com/$r "$d"; done
cd -    # back to bot-starter
```

Run `npm install` inside each fork's `bot-starter/` if an adapter complains about missing modules.
Alternatively, `bash sim/colab.sh` does all of this on Linux or Colab.

The public data is gitignored except for `data/price_table.json`, `data/top_table.json` and `data/profiles.json`.
Those three are enough for the live bot and the sim.
To refresh them:

```bash
bash scripts/pull_public.sh                # read-only SELECTs into data/ (never visible_auction_top_bids)
npx tsx scripts/build_price_table.ts       # price_table.json + top_table.json
npx tsx train/fit_profiles.ts              # profiles.json (proxies bron / lucent / maverick)
```

**Windows env vars.** In PowerShell, `BOT_NAME=nigel npm start` does not work. Use `$env:BOT_NAME='nigel'; $env:BOT_TOKEN='...'; npm start` instead, or run the command in Git Bash.

---

## 1. Status at handoff (Sat Nov 7, ~3:10 PM CT)

| Area | State |
|---|---|
| Word finder, bag/rival tracking, strategy (`src/`) | **Done.** Tests pass and typecheck is clean |
| Live client (`src/index.ts`): quick bid then revise, JSONL logs, auto-reconnect, tournament flag | **Written, never run live.** There is no `.token-nigel` file yet |
| Sim engine, opponent pool, runner, A/B compare, evolve (`sim/`) | **Done** |
| Top-bot proxies fitted from public data (`train/`) | **Done** (approximate) |
| Param tuning | Evolve gens 1–2 (seed 4242) **adopted into `params.json`** on Nov 7: place Δ −0.147 ± 0.107 vs bron/lucent/maverick/brutus/valor/cheapo, see `results/2026-11-07-adopt-evolve-gen2.md`. The afterword holdout is not yet checked |
| Git | **Public repo:** https://github.com/IKKNIGHT/nigel-scrabblebot (branch `main`, `upstream` = clockworklabs/scrabblebot). Commit and push as you go |
| README "Strategy" section for judges | **Missing.** `bot-starter/README.md` covers run, sim and layout only |

---

## 2. Remaining work, in priority order

Do these in order. Don't start on improvements until items 1 to 4 are done: a running public bot beats a better bot that isn't running.

1. ~~**Publish the repo.**~~ **Done** at https://github.com/IKKNIGHT/nigel-scrabblebot. Before each push, check `git status` so that no `.token-*`, `.env.local` or `logs/` files go in.
2. **Get the bot live.** The user must provide the token: link their identity at scrabblebot.spacetimedb.com/account, create a team, then press **Generate token** on /team. The token is shown only once.
   - First run: `BOT_NAME=nigel BOT_TOKEN=<token> npm start`. After that, `BOT_NAME=nigel npm start` (it uses the saved `.token-nigel`).
   - Run it in the background and keep it running until 11 PM. The rating needs 20–30 matches before the bot is ranked, so start early.
   - Check that `logs/<matchId>.jsonl` files appear, that no bids are rejected, and that the rack is empty at the end of each match.
3. **Adopt the tuned params.** Only after confirming the change:
   `npm run compare -- --a nigel --b nigel@results/evolve-best.json --matches 300`.
   If B's place is better and the CI doesn't cross 0, run `cp results/evolve-best.json params.json` and restart the live bot. Add a `results/<date>-<change>.md` note.
4. **Write the README "Strategy" section** for the judges (in `bot-starter/README.md` or the repo root README). Cover rack valuation and target words, the Vickrey bidding with pace and caps, the hold-vs-play policy, the endgame, the sim and evolve method, and the results tables.
5. **Continue tuning** while the bot runs live:
   `npm run evolve -- --generations 10 --mutants 8 --matches 150 --pool gaucho,bron,lucent,maverick,brutus,valor --holdout afterword --holdout-matches 60 --seed <new>`.
   It writes `results/evolve-best.json` and `results/<date>-evolve.md` and never overwrites `params.json`. It takes about 15 min per generation on 8 cores, and it's CPU-bound, so `SIM_WORKERS` sets the worker count.
   Guard against overfitting: the final params must still beat afterword (held out) and a table of only sim bots (`--table nigel,cheapo,valor,brutus,cheapo,valor`).
6. **Tournament prep (9–10 PM).** Test first-price mode in the sim with `npm run sim -- --first-price ...`.
   Ask the user for the tournament ID, then run `BOT_NAME=nigel TOURNAMENT_ID=<id> npm start`. An offline bot is still seated in a tournament and loses every auction, so the auto-reconnect matters.
7. **Optional upgrades,** only if time allows, and keep each one only if `compare` shows a significant place gain:
   - Placement-aware endgame: when trailing, hold out for 6–7 letter words and chase Z/Q/X/J; when leading, cash short words and use denial (`denyW` is currently 0).
   - Anti-targeting by opponent bot ID from `lobby_member`, capped at ±25% and off for unknown bots.
   - Tune the untuned keys `allIn`, `shade`, `flushAt` and `sevenPick` by adding ranges to `params.bounds.json`.

**Freeze at 10 PM CT:** commit and push the final params, README and results; check the repo is public; check the bot is running.

---

## 3. Commands cheat-sheet (run from `bot-starter/`)

```bash
npm start                                   # live bot (env: BOT_NAME, BOT_TOKEN first run, TOURNAMENT_ID)
npm test && npm run typecheck
npm run sim -- --matches 500 --table nigel,gaucho,afterword,valor,brutus,cheapo   # avg place / win rate / score, 95% CI
npm run compare -- --a nigel --b nigel@params.new.json --matches 300              # paired A/B on the same seeds
npm run evolve -- --generations 20 --mutants 8 --matches 150                      # param search
npx tsx train/eval.ts --matches 200 [--params f.json] [--vs other.json]           # vs training tables
```

Sim agent names:
- `nigel` or `nigel@<params.json>`
- `cheapo`, `valor`, `brutus`: the server's sim bots
- `starter`
- `gaucho`, `afterword`, `micah`, `taylor`: forks, loaded from `FORKS_DIR`
- `bron`, `lucent`, `maverick`: fitted proxies of top live bots

Sim flags: `--seed`, `--first-price`, `--workers`, `--no-rotate`, `--out`.

## 4. Code map (`bot-starter/`)

| Path | What |
|---|---|
| `src/rules.ts` | Letter values, bag, multipliers, the sim-bot bid rule (copied from the server) |
| `src/words.ts` | Compiled dictionary (masks and counts), fit test, best split, target-word potential |
| `src/view.ts` | Builds `BidCtx`/`WordCtx` from public tables: bag tracking, rival racks, balances |
| `src/strategy.ts` | `decideBid`, `chooseWords`. Pure (no network). Settings are in `params.json`; the meaning of each key is commented in the `Params` interface |
| `src/index.ts` | Live client. Filters `myRack` by matchId |
| `sim/engine.ts` | Seeded rules engine mirroring `spacetimedb/src/game.ts` (Vickrey and first-price) |
| `sim/opponents/` | Opponent pool and fork adapters (test-only, never imported by the live bot) |
| `sim/run.ts`, `compare.ts`, `evolve.ts`, `pool.ts` | Runner, paired A/B, evolutionary search, worker pool |
| `train/` | Fits bid profiles of top live bots from public history and evaluates against them |
| `scripts/` | Public data pull and price-table builder |
| `params.json` / `params.bounds.json` | Live params / tuning ranges |
| `results/` | Evolve reports and the best params found |

## 5. Engineering rules (keep these)

- `strategy.ts` stays pure, so the sim and the live bot run identical code. Never import from `forks/` in `src/`.
- Send a quick bid as soon as an auction opens, then revise it. Never wait for a reducer acknowledgement. Bid computation must stay under 100 ms.
- Bid 0 on the final auction (#68). The rack must be empty before the last auction closes, because the last tile can never be played.
- Never read `visible_auction_top_bids` (live bids are off-limits). Use only post-close public tables.
- Accept a change only on evidence: a paired `compare` of at least 300 matches whose place CI doesn't cross 0.
- Credit the forks and upstream in the README. The forks are sim opponents only.

## 6. Game facts (verified from server code)

| Area | Fact |
|---|---|
| Match | 6 bots. 98-tile bag (no blanks): A9 B2 C2 D4 E12 F2 G3 H2 I9 J1 K1 L4 M2 N6 O8 P2 Q1 R6 S4 T6 U4 V2 W2 X1 Y2 Z1. Each bot is dealt 5 hidden tiles. 68 auctions, 1 s each |
| Auction | Lobby matches are always Vickrey: the winner pays the 2nd-highest bid, and a sole bidder pays 1. Bids of 0 are dropped, ties are random, and bids can be revised until close. The tournament auction type is set by the admin, so first-price must work too |
| Balance | 100 coins at start. A bid above your balance is rejected. If your balance is below the price at close, the tile is lost. Unbid tiles are discarded |
| Words | ≥2 letters, from `spacetimedb/wordlist.txt`. Words can be played any time while the match runs, with no penalty for invalid ones |
| Reward | floor(letterSum × mult), where mult = 1 (≤3 letters), 1.5 (4), 2 (5), 2.5 (6), 3 (7+). The reward is added to both balance and score |
| End | The match ends with the final auction. Leftover coins and tiles are worth 0 |
| Sim bots | Bid once, at open: Cheapskate = value−1, ValueBidder = value, Aggressive = value+2 (vowels +4), ±2 jitter, capped at balance. After each win they play their longest word of 3+ letters |
| Lobby | Fills to 6 seats. Otherwise sim bots fill the seats after 90 s |

The bar to clear: top public bots average 78–92 points per match, with 71–85% of their points from 7+ letter words.

## Open questions (ask the user, who can ask at the Spacetime booth)
- What exactly counts as "submitting" for the 11 PM deadline?
- When is the tournament, which auction type does it use, and what table size?

Sources: https://scrabblebot.spacetimedb.com/docs · https://github.com/clockworklabs/scrabblebot · strategy doc https://claude.ai/artifact/JKuTD6JYYE9WzRuBJwdmUx
