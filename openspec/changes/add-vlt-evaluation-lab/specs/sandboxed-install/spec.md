## ADDED Requirements

### Requirement: Per-phase sandbox profiles
The lab SHALL ship nono profiles for the resolve/fetch phase, the query phase, and the build phase. The fetch phase SHALL reach only registry hosts from the active profile; the query phase SHALL additionally reach the security data host; the build phase SHALL have no network and SHALL write only inside the project directory and declared caches.

#### Scenario: Exfiltration attempt during build
- **WHEN** a dependency's postinstall script tries to read a file under the user's home directory and send it over the network
- **THEN** the read is denied by the kernel, the network call fails, and the canary value never leaves the sandbox

#### Scenario: Registry outside the allowlist
- **WHEN** a client inside the fetch sandbox requests a registry host absent from the profile
- **THEN** the request is refused with an HTTP 403 from the sandbox proxy

### Requirement: Untrusted fork pipeline
The lab SHALL provide one command that takes a repository URL or path, copies it to a scratch location, and runs fetch, query gate, and build phases under their sandboxes, producing a JSON report.

#### Scenario: Report shape
- **WHEN** the pipeline finishes, successfully or not
- **THEN** the report records the source, detected manager, per-phase exit codes, gate results, built and pending packages, and timings
