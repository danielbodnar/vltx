# Provenance

This skill is vendored unchanged from the `skills/dss-query/` directory of a published npm package. Only this file and `LICENSE` (copied from the package root, as its licence requires) were added.

| Field | Value |
|---|---|
| Package | `@vltpkg/query` |
| Version | `1.3.6` |
| Tarball | https://registry.npmjs.org/@vltpkg/query/-/query-1.3.6.tgz |
| dist.integrity | `sha512-6uyVa9S5JSTnGCqfnq8xfTjC6QYiYNRaGU3wZMPCzR9FOpU6ziWYlBwELuf/JTfNdO6VF3ygAn2jAKvkw4xb/g==` |
| dist.shasum | `590874316d625eee042e14a0775e6c50c5b9df5b` |
| Tarball sha256 | `31d2f592576ddbd16594faebc47fc2e95d7d2bdbad9109a4492318bb33f6def4` |
| Licence | `BSD-2-Clause-Patent` (package.json `license` field; the package `LICENSE` file is the BSD-2-Clause Plus Patent text, copyright vlt technology, Inc.) |
| Upstream source | https://github.com/vltpkg/vltpkg, directory `src/query` |
| Retrieved | 2026-10-04 with `npm pack @vltpkg/query@1.3.6` and `npm view @vltpkg/query@1.3.6 dist --json` |

Files taken from the tarball: `SKILL.md`, `REFERENCE.md`, `evals/README.md`, `evals/evals.json`, `evals/grade.mjs`.

`evals/grade.mjs` imports from the upstream repository (`../../../src/index.ts`, `@vltpkg/dss-parser`) and only runs inside a vltpkg checkout. It is kept so the vendored directory matches upstream; agents using the skill do not need it.

To refresh: pack the new version, replace the five files, and update this table.
