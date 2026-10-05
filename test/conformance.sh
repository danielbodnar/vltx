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
# Quoting probe: shell and Nushell metacharacters in every value must render identically in all
# three implementations, and sourcing env-sh or env-nu must give back exactly the profile's values.
HOSTILE=$ROOT/test/fixtures/hostile.profiles.json
for t in $targets; do
  bun "$ROOT/packages/registry-profile/src/cli.ts" render "$t" --file "$HOSTILE" > "$TMP/ref"
  VLT_LAB_PROFILES=$HOSTILE sh "$ROOT/lib/sh/registry-profile.sh" render "$t" > "$TMP/sh"
  nu "$ROOT/lib/nu/registry-profile-cli.nu" render "$t" --file "$HOSTILE" > "$TMP/nu"
  for impl in sh nu; do
    if cmp -s "$TMP/ref" "$TMP/$impl"; then pass=$((pass + 1)); else
      fail=$((fail + 1)); printf 'MISMATCH %s hostile %s\n' "$impl" "$t"; diff "$TMP/ref" "$TMP/$impl" | head -8 || true
    fi
  done
done
bun -e 'import { envPairs, loadProfiles, pickProfile } from "'"$ROOT"'/packages/registry-profile/src/index.ts";
  process.stdout.write(JSON.stringify(Object.fromEntries(envPairs(pickProfile(loadProfiles(process.argv[1]), undefined, {})))));' "$HOSTILE" > "$TMP/want"
bun "$ROOT/packages/registry-profile/src/cli.ts" render env-sh --file "$HOSTILE" > "$TMP/env.sh"
bun "$ROOT/packages/registry-profile/src/cli.ts" render env-nu --file "$HOSTILE" > "$TMP/env.nu"
keys=$(jq -c 'keys' "$TMP/want")
(cd "$TMP" && env -i PATH="$PATH" sh -c '. ./env.sh; jq -nc --argjson k "$1" '"'"'[$k[] | {(.): env[.]}] | add'"'"'' sh "$keys") > "$TMP/got-sh"
# Nushell env names are case-insensitive, so npm_config_registry and NPM_CONFIG_REGISTRY share one entry
(cd "$TMP" && nu -n -c "source env.nu; $keys | reduce --fold {} {|k, acc| \$acc | insert \$k (\$env | transpose k v | where {|e| (\$e.k | str lowercase) == (\$k | str lowercase) } | first | get v) } | to json --raw") > "$TMP/got-nu"
for impl in sh nu; do
  if jq -e --slurpfile w "$TMP/want" '. == $w[0]' "$TMP/got-$impl" >/dev/null && [ ! -e "$TMP/pwned" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); printf 'ROUNDTRIP %s: sourced values differ from the profile\n' "$impl"
  fi
done

printf 'conformance: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
