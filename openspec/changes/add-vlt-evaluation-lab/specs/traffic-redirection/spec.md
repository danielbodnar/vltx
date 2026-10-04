## ADDED Requirements

### Requirement: Enforcement without redirection
The lab SHALL show that a sandbox allowlist containing only the chosen registry host makes any client that ignores configuration fail fast instead of silently using the public registry.

#### Scenario: Hardcoded public registry
- **WHEN** a client inside the enforcement sandbox requests `registry.npmjs.org` while the profile names another registry
- **THEN** the request is refused

### Requirement: Transparent redirection
The lab SHALL provide an opt-in redirector that answers for public registry hostnames inside an isolated mount namespace, trusts a locally generated CA only within that namespace, and forwards requests to the profile's registry.

#### Scenario: Lockfile pinned to the public registry
- **WHEN** a lockfile pins `https://registry.npmjs.org/...` tarball URLs and the client runs under the redirector
- **THEN** the tarballs are served by the profile's registry and the host system's `/etc/hosts` and trust store are untouched
