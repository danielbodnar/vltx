#!/bin/sh
# Conformance: the Nushell and POSIX sh renderers must match the TypeScript reference byte for byte.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export VLT_ACCOUNT=${VLT_ACCOUNT:-acme} CF_WORKERS_SUBDOMAIN=${CF_WORKERS_SUBDOMAIN:-example}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/vlt-lab-conf.XXXXXX"); trap 'rm -rf "$TMP"' EXIT
profiles=$(jq -r '.profiles | keys_unsorted[]' "$ROOT/config/registry.profiles.json")
targets="npmrc bunfig yarnrc vlt-json env-sh env-nu hosts"
pass=0 fail=0
for p in $profiles; do
  for t in $targets; do
    bun "$ROOT/packages/registry-profile/src/cli.ts" render "$t" "$p" > "$TMP/ref"
    for impl in sh nu; do
      case $impl in
        sh) sh "$ROOT/lib/sh/registry-profile.sh" render "$t" "$p" > "$TMP/$impl" ;;
        nu) nu "$ROOT/lib/nu/registry-profile-cli.nu" render "$t" "$p" > "$TMP/$impl" ;;
      esac
      if cmp -s "$TMP/ref" "$TMP/$impl"; then pass=$((pass + 1)); else
        fail=$((fail + 1)); printf 'MISMATCH %s %s %s\n' "$impl" "$p" "$t"; diff "$TMP/ref" "$TMP/$impl" | head -8 || true
      fi
    done
  done
done
printf 'conformance: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
