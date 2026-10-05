# Shared helpers for Nushell examples: `use ../../lib/nu/common.nu *` (adjust depth)

const LIB_DIR = path self .
export const VL_ROOT = ($LIB_DIR | path join .. .. | path expand)

export def vl-log [msg: string] { print --stderr $"[vlt-lab] ($msg)" }

export def vl-need [...cmds: string] {
  for c in $cmds { if (which $c | is-empty) { error make --unspanned { msg: $"missing required command: ($c)" } } }
}

export def vl-shim-dir []: nothing -> path {
  $env.VLT_LAB_SHIM_DIR? | default (($env.XDG_DATA_HOME? | default ($env.HOME | path join .local share)) | path join vlt-lab shims)
}

# First executable named `name` on PATH outside the shim directory.
export def vl-real-bin [name: string]: nothing -> path {
  let shim = vl-shim-dir | path expand
  let hit = $env.PATH
    | where {|d| ($d | path expand) != $shim }
    | each {|d| $d | path join $name }
    | where {|p| ($p | path exists) and (($p | path type) != dir) }
    | first 1
  if ($hit | is-empty) { error make --unspanned { msg: $"($name) not found on PATH outside ($shim)" } }
  $hit.0
}

# Scratch directory under <repo>/.tmp
export def vl-scratch [label: string]: nothing -> path {
  let base = $VL_ROOT | path join .tmp
  mkdir $base
  mktemp --directory --tmpdir-path $base $"($label).XXXXXX"
}
