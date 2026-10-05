## ADDED Requirements

### Requirement: npm-compatible proxy
The gate SHALL serve packuments and tarballs for any package from a configured npm-compatible upstream, rewriting tarball URLs to point at itself.

#### Scenario: Packument fetch
- **WHEN** a client requests `/<name>` or `/@scope%2fname`
- **THEN** the response matches the upstream packument with every `dist.tarball` rewritten to the gate's origin

### Requirement: Malware blocking
The gate SHALL remove versions with an OSV advisory whose identifier starts with `MAL-` from packuments and SHALL answer requests for their tarballs with HTTP 451 and a JSON body naming the advisories.

#### Scenario: Malicious version requested directly
- **WHEN** a client requests the tarball of a version flagged `MAL-*`
- **THEN** the gate responds 451 without contacting the upstream for that tarball

#### Scenario: Advisory service unavailable
- **WHEN** OSV cannot be reached
- **THEN** the gate follows its configured failure mode, closed by default, and says so in a response header
