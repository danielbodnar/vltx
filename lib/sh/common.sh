# shellcheck shell=sh
# Shared helpers for POSIX sh examples. Source with:
#   . "$(dirname "$0")/../../lib/sh/common.sh"   (adjust depth)

VL_ROOT=${VL_ROOT:-$(CDPATH= cd -- "$(dirname -- "${VL_COMMON:-$0}")" && git rev-parse --show-toplevel 2>/dev/null || pwd)}
VL_SHIM_DIR=${VLT_LAB_SHIM_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/vlt-lab/shims}

vl_log() { printf '[vlt-lab] %s\n' "$*" >&2; }
vl_die() { vl_log "error: $*"; exit 1; }
vl_need() { for _c in "$@"; do command -v "$_c" >/dev/null 2>&1 || vl_die "missing required command: $_c"; done; }

# vl_profile <args...>: run the POSIX profile renderer
vl_profile() { sh "$VL_ROOT/lib/sh/registry-profile.sh" "$@"; }

# vl_real_bin <name>: first executable named <name> on PATH that is not inside the shim dir
vl_real_bin() {
  _shim=$(CDPATH= cd -- "$VL_SHIM_DIR" 2>/dev/null && pwd -P || printf '%s' "$VL_SHIM_DIR")
  _old_ifs=$IFS; IFS=:
  for _d in $PATH; do
    IFS=$_old_ifs
    [ -n "$_d" ] || continue
    _dp=$(CDPATH= cd -- "$_d" 2>/dev/null && pwd -P) || continue
    [ "$_dp" = "$_shim" ] && continue
    if [ -x "$_dp/$1" ] && [ ! -d "$_dp/$1" ]; then printf '%s\n' "$_dp/$1"; return 0; fi
  done
  IFS=$_old_ifs
  return 1
}

# vl_scratch <label>: create a scratch dir under $VL_ROOT/.tmp and print it
vl_scratch() { mkdir -p "$VL_ROOT/.tmp" && mktemp -d "$VL_ROOT/.tmp/$1.XXXXXX"; }
