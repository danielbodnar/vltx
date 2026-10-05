#!/bin/sh
# enforce.sh: run any command with network egress limited to the hosts of one registry profile.
# No redirection: the command keeps whatever registry it was told to use, and anything outside
# the profile's hosts is refused by nono (HTTP 403 from nono's proxy, or a Landlock port denial).
#
#   sh enforce.sh [--profile REGISTRY_PROFILE] [--project DIR] [--dry-run] -- <command> [args...]
#
# Thin wrapper over the `run` phase of examples/07-nono-sandboxing (profile net-only.jsonc), which
# owns the host-to-flag composition: remote hosts become --allow-domain, loopback hosts
# (127.0.0.1:8787 for gate-local) become --open-port plus --sandbox-policy landlock.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }
case ${1:-} in
  "") usage >&2; exit 2 ;;
  -h|--help) usage; exit 0 ;;
esac
exec sh "$HERE/../../07-nono-sandboxing/sandbox-phase.sh" run "$@"
