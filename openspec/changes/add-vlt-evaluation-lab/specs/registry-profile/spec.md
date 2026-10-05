## ADDED Requirements

### Requirement: One profile document describes every backend
The lab SHALL read registry backends from a single JSON document validated by a JSON Schema 2020-12 file. Each profile SHALL name an npm-compatible mirror URL and MAY name a private registry URL, the scope routed to it, the environment variable that holds its token, and extra hosts a sandbox must reach.

#### Scenario: Unknown profile
- **WHEN** a tool is asked to render a profile name absent from the document
- **THEN** it exits non-zero and lists the available profile names

#### Scenario: Account placeholder
- **WHEN** a URL contains `{account}` and `VLT_ACCOUNT` is set
- **THEN** every rendered URL carries the account slug, and rendering fails with a clear message when the variable is unset

### Requirement: Rendering targets every client
The renderer SHALL emit `.npmrc`, `bunfig.toml`, `.yarnrc.yml`, `vlt.json`, POSIX environment exports, and Nushell environment assignments from a profile. Tokens SHALL appear only as environment references in each client's expanding syntax, never as literal secrets.

#### Scenario: Token syntax per client
- **WHEN** a profile names `tokenEnv: VLT_TOKEN`
- **THEN** `.npmrc` uses `${VLT_TOKEN}`, `bunfig.toml` uses `$VLT_TOKEN`, and `.yarnrc.yml` uses `${VLT_TOKEN:-}`

#### Scenario: Scripts disabled by default
- **WHEN** a profile does not override its policy
- **THEN** every rendered file disables dependency lifecycle scripts for clients that support a switch

### Requirement: Implementations agree
The Nushell, POSIX sh, and TypeScript renderers SHALL produce byte-identical output for every profile and target.

#### Scenario: Conformance run
- **WHEN** the conformance test renders every profile and target with all three implementations
- **THEN** all outputs match the TypeScript reference
