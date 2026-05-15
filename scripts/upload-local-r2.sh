#!/usr/bin/env bash
# Upload data/egm08_cog.tif (and any other files passed as args) into the
# local Miniflare-backed R2 bucket used by `wrangler dev`.
#
# Usage:
#   bash scripts/upload-local-r2.sh                   # uploads data/egm08_cog.tif as egm08_cog.tif
#   bash scripts/upload-local-r2.sh path/to/file.tif  # uploads under its basename
#   bash scripts/upload-local-r2.sh key=path/file.tif # uploads under an explicit key
#
# Bucket name matches `[[r2_buckets]] bucket_name` in wrangler.toml.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-reearth-terrain}"
KEY_PREFIX="${KEY_PREFIX:-sources/}"

cd "$ROOT"

inputs=("$@")
if [[ ${#inputs[@]} -eq 0 ]]; then
  inputs=("data/egm08_cog.tif")
fi

for spec in "${inputs[@]}"; do
  if [[ "$spec" == *"="* ]]; then
    key="${spec%%=*}"
    file="${spec#*=}"
  else
    file="$spec"
    key="${KEY_PREFIX}$(basename "$file")"
  fi

  if [[ ! -s "$file" ]]; then
    echo "error: file not found or empty: $file" >&2
    exit 1
  fi

  echo "[upload-local-r2] $file -> $BUCKET/$key"
  npx wrangler r2 object put "$BUCKET/$key" \
    --file="$file" \
    --content-type="image/tiff" \
    --local
done
