## ADDED Requirements

### Requirement: Dispatch
`vltx` SHALL run its own command when the first positional argument names a vltx command or alias, SHALL run `init` when no command is given, and SHALL execute `vlt` with the original arguments otherwise, returning vlt's exit code. `vltx vlt <args>` and `vltx vlx <args>` SHALL execute `vlt`/`vlx` directly; `vltx nono <args>` SHALL execute `nono` directly unless the first argument names a vltx nono helper.

#### Scenario: Pass-through
- **WHEN** the user runs `vltx query ':malware'`
- **THEN** vltx executes `vlt query ':malware'` with inherited stdio and exits with vlt's exit code

#### Scenario: No arguments in a fresh repo
- **WHEN** the user runs `vltx` in a repository with no `.vltx.json`
- **THEN** vltx prints what it detected and starts the init wizard

### Requirement: One-shot migration
`vltx -y` SHALL migrate the repository onto vlt and the account's private registry: resolve the account (flag, `VLT_ACCOUNT`, package scope), require `VLT_TOKEN`, back up every file it changes or removes into `.vltx/backup/<UTC>/`, configure vlt for the project, render client configs, reinstall with scripts denied, run the security gate, and record everything in `.vltx.json`.

#### Scenario: Missing account
- **WHEN** `-y` is given and no account can be resolved
- **THEN** vltx exits 2 and names the `--account` flag, changing nothing

#### Scenario: Dry run
- **WHEN** `--dry-run` is given
- **THEN** vltx prints the plan and changes no file

### Requirement: Reversible
`vltx remove` SHALL restore every backed-up file listed in `.vltx.json` and delete only files that `.vltx.json` records as created by vltx.

#### Scenario: Round trip
- **WHEN** a repository is migrated and then removed
- **THEN** every original file is byte-identical to its state before migration
