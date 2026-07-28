#!/usr/bin/env bash
# Fetches the real-world spec corpus into ./specs/. Re-run to refresh.
# Specs are gitignored: they are large, sometimes licensed, and this
# script regenerates them.
#
# Three sources, in order of how much is known about them:
#   1. $OAV_AUDITED_SPECS -- a local directory of already-audited specs
#      (ground truth known; used to sanity-check the harness). Skipped
#      when unset or absent.
#   2. the seven large public specs conformance/real-world already uses.
#   3. an apis.guru sample chosen by select-guru.mjs.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p specs

AUDITED="${OAV_AUDITED_SPECS:-$HOME/Desktop/oav-learnings-repro/specs}"
if [ -d "$AUDITED" ]; then
  for f in "$AUDITED"/*.yaml "$AUDITED"/*.json; do
    [ -e "$f" ] || continue
    cp "$f" "specs/audited-$(basename "$f")"
  done
  echo "audited: $(ls specs/audited-* 2>/dev/null | wc -l | tr -d ' ') copied"
else
  echo "audited: $AUDITED not present, skipped"
fi

fetch() { curl -sSfL --max-time 180 -o "specs/$1" "$2" || echo "FAILED $1" >&2; }

fetch large-adyen-checkout.json https://api.apis.guru/v2/specs/adyen.com/CheckoutService/70/openapi.json &
fetch large-asana.yaml https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml &
fetch large-box.json https://raw.githubusercontent.com/box/box-openapi/main/openapi.json &
fetch large-digitalocean.yaml https://api.apis.guru/v2/specs/digitalocean.com/2.0/openapi.yaml &
fetch large-github.json https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json &
fetch large-stripe.json https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json &
fetch large-twilio.json https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json &
wait

curl -sSfL --max-time 180 -o specs/.guru-list.json https://api.apis.guru/v2/list.json
node select-guru.mjs specs/.guru-list.json > specs/.guru-urls.tsv
echo "apis.guru: $(wc -l < specs/.guru-urls.tsv | tr -d ' ') selected"

# 8 at a time: apis.guru serves these from a CDN, and a wider fan-out
# trades throughput for timeouts.
xargs -P 8 -L 1 bash -c 'curl -sSfL --max-time 120 -o "specs/$0" "$1" || echo "FAILED $0" >&2' \
  < specs/.guru-urls.tsv

echo "total: $(ls specs | grep -cv '^\.') specs in $(du -sh specs | cut -f1)"
