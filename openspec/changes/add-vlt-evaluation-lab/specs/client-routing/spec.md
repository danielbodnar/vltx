## ADDED Requirements

### Requirement: User-level configuration apply
The lab SHALL write rendered configuration into the user's client config locations only when invoked with an explicit apply flag. Without it, the tool SHALL print a diff of the changes it would make.

#### Scenario: Dry run by default
- **WHEN** the user runs the config tool without `--apply`
- **THEN** no file outside the repository changes and a unified diff is printed per target

#### Scenario: Backup before replace
- **WHEN** the tool applies over an existing file
- **THEN** the previous file is copied to a timestamped backup and the restore command prints its path

### Requirement: PATH shim dispatcher
The lab SHALL provide shims named `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, `bun`, `bunx`, and `vlx` that resolve the real binary outside the shim directory and run it under a selected mode: `env` (inject the profile), `vlt` (route installs through vlt), `nono` (sandbox the call), or `off` (pass through).

#### Scenario: Recursion guard
- **WHEN** the shim directory appears more than once on PATH
- **THEN** the dispatcher still resolves a non-shim binary or exits with a message naming the missing tool

#### Scenario: Install verb routed to vlt
- **WHEN** mode is `vlt` and the user runs `npm install` with no package arguments
- **THEN** the dispatcher runs the phased install from `phased-install` instead of the npm install
