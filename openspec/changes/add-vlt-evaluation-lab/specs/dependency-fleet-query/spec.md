## ADDED Requirements

### Requirement: Fleet security query
The lab SHALL run a configurable set of dependency selector queries across every vlt-installed project under one or more root directories and emit results as JSON and CSV.

#### Scenario: Project not installed by vlt
- **WHEN** a project under the root was installed by another client
- **THEN** the report lists it as unscanned, with an option to shadow-install it into a scratch directory and scan that copy
