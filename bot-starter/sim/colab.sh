#!/usr/bin/env bash
# One-shot setup for Colab (or any Linux box). In a cell:
#   !bash /content/scrabblebot/bot-starter/sim/colab.sh
# then e.g.
#   !cd /content/scrabblebot/bot-starter && FORKS_DIR=/content/forks npx tsx sim/evolve.ts --generations 20
# Uses every core (override with SIM_WORKERS). Pick a runtime with many vCPUs
# (A100 / high-RAM); the GPU itself is not used.
set -euo pipefail
BOT="$(cd "$(dirname "$0")/.." && pwd)"
FORKS="${FORKS_DIR:-$(dirname "$(dirname "$BOT")")/forks}"

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
echo "node $(node --version), $(nproc) cores"

mkdir -p "$FORKS"
for r in JoaquinGiorgis/scrabblebot-gaucho Jose-Gael-Cruz-Lopez/afterword-scrabblebot Phaslyr/scrabblebot micahlai/scrabblebot; do
  d="$FORKS/$(echo "$r" | tr / _)"
  [ -d "$d" ] || git clone -q --depth 1 "https://github.com/$r" "$d"
done

cd "$BOT"
npm install --silent
npm run bindings >/dev/null
echo "ready: FORKS_DIR=$FORKS"
