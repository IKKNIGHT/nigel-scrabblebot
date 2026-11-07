#!/usr/bin/env bash
# Pull public, post-auction tables from maincloud into data/. Read-only
# SELECTs. Never reads visible_auction_top_bids (live bids are off-limits).
# auction_result has millions of rows, so per-match tables are limited to
# the last RECENT matches (default 2000), or to match ids >= SINCE.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
URL="${STDB_HOST:-https://maincloud.spacetimedb.com}/v1/database/${STDB_DB:-scrabblebot}/sql"
q() { curl -sS -X POST "$URL" --data "$1"; }

for t in bot bot_stats; do
  echo "pulling $t"
  q "SELECT * FROM $t" > "data/$t.json"
done
q "SELECT id FROM match_state" > data/match_ids.json
SINCE="${SINCE:-$(node -e '
  const r = JSON.parse(require("fs").readFileSync("data/match_ids.json","utf8"))[0].rows.map(x => Number(x[0]));
  console.log(Math.max(0, Math.max(...r) - Number(process.env.RECENT || 2000)));
')}"
echo "matches with id >= $SINCE"
q "SELECT * FROM match_state WHERE id >= $SINCE" > data/match_state.json
for t in match_participant auction_result auction_top_bid_archive word_play; do
  echo "pulling $t"
  q "SELECT * FROM $t WHERE match_id >= $SINCE" > "data/$t.json"
done
q "SELECT * FROM lobby_member" > data/lobby_member.json
echo "done: $(ls data/*.json | wc -l) files in data/"
