#!/usr/bin/env bash
# Download the EGM2008 geoid undulation grid as a Cloud Optimized GeoTIFF.
#
# Source: PROJ data CDN. The file is already a COG (Float32, DEFLATE,
# 256x256 tiled, EPSG:4979), so no GDAL post-processing is required — we
# just save it as-is.
#
# Usage:
#   bash scripts/fetch-egm08.sh           # writes data/egm08_cog.tif
#   FORCE=1 bash scripts/fetch-egm08.sh   # re-download

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/data"
SRC_URL="https://cdn.proj.org/us_nga_egm08_25.tif"
OUT_FILE="$DATA_DIR/egm08_cog.tif"

FORCE="${FORCE:-0}"

command -v curl >/dev/null 2>&1 || {
  echo "error: required command not found: curl" >&2
  exit 1
}

mkdir -p "$DATA_DIR"

if [[ -s "$OUT_FILE" && "$FORCE" != "1" ]]; then
  echo "[fetch-egm08] already present: $OUT_FILE (set FORCE=1 to re-download)"
  exit 0
fi

echo "[fetch-egm08] downloading $SRC_URL"
curl -fL --retry 3 --retry-delay 2 -o "$OUT_FILE.tmp" "$SRC_URL"
mv "$OUT_FILE.tmp" "$OUT_FILE"

echo
echo "[fetch-egm08] done"
ls -la "$OUT_FILE"
