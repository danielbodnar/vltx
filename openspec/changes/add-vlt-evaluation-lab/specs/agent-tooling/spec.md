## ADDED Requirements

### Requirement: vlt MCP server
The lab SHALL provide a stdio MCP server exposing read-only vlt operations: dependency queries with optional expectation, package metadata lookup, effective configuration, registry ping, and the fleet query. Mutating operations SHALL NOT be exposed.

#### Scenario: Query tool
- **WHEN** an agent calls the query tool with a selector and a project path
- **THEN** it receives structured results and the raw vlt exit code

### Requirement: Repository skills
The repository SHALL carry the official vlt `dss-query` skill with its provenance and a repository skill describing how to choose and run the examples safely.

#### Scenario: Provenance
- **WHEN** the vendored skill is inspected
- **THEN** a provenance file records the source package, version, and integrity hash
