## ADDED Requirements

### Requirement: Install any repository with vlt
The lab SHALL install a repository's dependencies with vlt regardless of the repository's declared package manager, without running any lifecycle scripts, and report which package manager and lockfile it detected.

#### Scenario: Foreign lockfile
- **WHEN** the repository carries `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or `bun.lock`
- **THEN** the report records the detected manager and notes that vlt performed a fresh resolution

### Requirement: Security gate before build
After install, the lab SHALL evaluate a list of vlt dependency selector queries, each with an expected result count, and SHALL stop before any build step when an expectation fails.

#### Scenario: Malware present
- **WHEN** `:malware` matches one or more packages
- **THEN** the pipeline exits non-zero, writes the matched packages to the report, and runs no lifecycle script

### Requirement: Build only approved packages
The build step SHALL run lifecycle scripts only for packages matching a configured selector, defaulting to `:scripts:not(:built):not(:malware)`, and SHALL record what was built and what was skipped.

#### Scenario: Scripts awaiting approval
- **WHEN** a package with an install script is outside the build selector
- **THEN** it remains unbuilt and appears in the report as pending approval
