# 06 host queries: fleet-wide security queries

vlt can query many projects at once. Its `:host(local)` selector loads every vlt-installed project found under the configured `dashboard-root` directories into one graph, and `:host("file:<abs>")` loads a single one. `fleet-scan` turns that into a fleet report: it runs a list of selectors (malware, CVEs, install scripts, unbuilt scripts, outdated direct dependencies, deprecated packages) across every project under one or more roots, prints one row per (project, query, package) plus a summary per project, and lists the projects vlt cannot see. With `--shadow` it copies the `package.json` of each of those into a scratch directory, installs it there without scripts, and scans the copy instead, labelled `shadow`.

## Files

| File | Purpose |
|---|---|
| `fleet-scan.sh`, `.nu`, `.ts` | Entrypoints with the same CLI and byte-identical CSV and table output |
| `queries.default.json` | Default query list |
| `test.sh` | Builds a temp fleet, records raw vlt behaviour, runs all three implementations and compares them |

## Usage

```sh
sh  examples/06-host-queries/fleet-scan.sh [--root DIR ...] [--queries FILE] [--format json|csv|table] [--shadow] [--out DIR] [--profile NAME]
nu  examples/06-host-queries/fleet-scan.nu  (same flags)
bun examples/06-host-queries/fleet-scan.ts  (same flags)
```

| Option | Meaning |
|---|---|
| `--root DIR` | Directory to scan, repeatable; default `$HOME` (vlt's own default). Each becomes `--dashboard-root=DIR`. |
| `--queries FILE` | Query list (default `queries.default.json`) |
| `--format` | stdout format: `json` (full results), `csv` (rows), `table` (rows, blank line, summary; default) |
| `--shadow` | Scan package.json-only copies of projects that are not vlt-installed |
| `--out DIR` | Output directory (default: a new `mktemp` dir under `<repo>/.tmp`) |
| `--profile NAME` | Registry profile for the vlt calls (default `$VLT_LAB_PROFILE`, then `npmjs`) |

Exit codes: `0` ok, `1` at least one query failed (listed in `results.json` `errors`), `2` usage.

Outputs in `--out`: `results.json`, `rows.csv`, `summary.csv`, `vlt.json` (an empty `{}` so vlt run from this directory never adopts a parent project's config), and `shadow/<slug>/` with `--shadow`.

### Queries file

```json
{ "queries": [ { "name": "malware", "selector": ":malware" }, { "name": "outdated-direct", "selector": ":root > :outdated(major)" } ] }
```

Defaults: `malware` `:malware`, `cves` `:cve`, `scripts` `:scripts`, `unbuilt` `:scripts:not(:built)`, `outdated-direct` `:root > :outdated(major)`, `deprecated` `:deprecated`. Security selectors call `api.socket.dev`; `:outdated` fetches packuments from the profile registry. Both answered in under a second with a cold cache for a small fleet during development probes.

### results.json

`{schemaVersion, tool, implementation, generatedAt, vltVersion, roots, dashboardRoots, out, shadow, queriesFile, queries, projects, rows, errors}`

- `projects[]`: `{project, name, status, scannedPath, shadow, via, counts}`. `status` is `scanned`, `shadow`, `unscanned` or `shadow-failed`; `via` is `host-local`, `host-file` or `null`; `counts` maps query name to row count (`null` when unscanned); `shadow` is `{project, path, method, error}`.
- `rows[]`: `{project, status, via, query, selector, package, version, id}`, sorted by project, query order, id; deduplicated per (project, query, id).
- `errors[]`: `{query, project, message}`.

`rows.csv` columns: `project,status,via,query,package,version,id`. `summary.csv` columns: `project,name,status,via,<query names...>`.

## How it works

1. **Discover.** Walk each root the way vlt's dashboard does (read from the 1.3.6 bundle, `chunk-WS7BNE5S.js`): skip symlinks, dot directories and `node_modules`; directly under `$HOME` also skip downloads, movies, music, pictures, private, library, dropbox, videos and public; stop at depth 7; a directory with a regular `package.json` is a project and is not descended into. The root directory itself is never a project. A project is vlt-installed when `node_modules/.vlt/` or `node_modules/.vlt-lock.json` exists.
2. **Shadow** (optional). For each project that is not vlt-installed: copy its `package.json` to `<out>/shadow/<slug>/` (slug: absolute path with `/` and other unsafe characters turned into `_`), add `{}` as `vlt.json` to pin vlt's root, run `vlt install --lockfile-only --allow-scripts=':not(*)'`, check whether `vlt query` works, and when it does not, run a full `vlt install --allow-scripts=':not(*)'`. `<out>/shadow` is added as one more dashboard root. The original project is never written to.
3. **List what vlt sees.** `vlt query ':host(local) :root' --dashboard-root=...` returns one importer per loaded project with `to.projectRoot`.
4. **Route.** Projects in that list are queried through `:host(local) <selector>`, one call per query for the whole fleet, with every match attributed by `to.projectRoot`. vlt-installed or shadow projects missing from it (see the name collision below) are queried one by one through `:host("file:<abs>") <selector>`. A selector that starts with `:root` is attached without a space in that form (`:host("file:/p"):root > :outdated(major)`), because inside a `file:` context the project importer is the `:host()` result itself.
5. **Report.** Rows are joined back to projects through the scanned path, counted per query, and written in all three formats.

## Verified `:host(local)` behaviour (vlt 1.3.6)

Evidence comes from probes during development and from the `vlt:` checks in `test.sh`, all with `HOME` and `XDG_*` in a temp dir:

| Question | Observation |
|---|---|
| Does `:host(local)` output say which project a match belongs to? | Yes. Every edge's `to.projectRoot` is the absolute project path. A package used by two projects comes back twice, once per project (`~npm~left-pad@1.3.0` with `projectRoot` proj-a and proj-b). No per-project iteration is needed for attribution. |
| Which projects are included? | Only vlt-installed ones. With a root holding two vlt-installed projects and one npm-installed project, `:host(local) :root` returned exactly the two. |
| Flag name | `--dashboard-root=<dir>` works and is repeatable; `VLT_DASHBOARD_ROOT=<dir>` also works. Without it the root is `$HOME`. A `dashboard-root` that is itself a project directory yields no projects (only its descendants are walked). |
| Same package name in two projects | Projects whose root `package.json` has the same `name` collapse to one in `:host(local)`: with `proj-numbers` under two roots, `:host(local) :root` listed one of them and none of the other one's dependencies. `:host("file:<abs>")` still reaches both. fleet-scan detects the missing one and scans it through `file:`. |
| `file:` contexts | Keys exist for every discovered project as `file:<abs>`, `file:~/<home-relative>`, `file:<cwd-relative>` and `file:./<cwd-relative>` (with or without trailing `/`). A path outside every dashboard root gives `Unknown host context`. An npm-installed project under a root is a known context but returns `[]` for every selector, without an error. |
| `:root` under each context | `:host(local) :root` and `:host(local) > :root` are the project importers; `:host(local) :root > *` are direct dependencies. `:host("file:p") :root > *` returns nothing, `:host("file:p"):root > *` and `:host("file:p") > *` return the direct dependencies. |
| `vlt install --lockfile-only` for shadows | Writes `vlt-lock.json` and no `node_modules`, and `vlt query` then fails with `No vlt install found`. Shadows therefore always fall back to a full `vlt install` (no scripts), and `shadow.method` is `install`. |

## Results

Command: `sh examples/06-host-queries/test.sh` on 2026-10-04 (vlt 1.3.6, Bun 1.4.2, Nushell 0.116.0, npm 10.9). Outcome of the final run: **68 passed, 0 failed** in about 33 seconds (an earlier run the same day gave 67 of 67 before the scratch-leak check was added).

Test fleet: `fleet/proj-esbuild` (vlt, esbuild@0.25.0 not built, left-pad@1.3.0), `fleet/team/proj-numbers` (vlt, is-number@6.0.0), `fleet/proj-npm` (npm, left-pad@1.3.0), and a second root `fleet2/proj-numbers-fork` (vlt, package name also `proj-numbers`, is-number@7.0.0).

| Case (sh, nu, ts each) | Observed |
|---|---|
| `--root fleet --format json` | exit 0, stdout equals `results.json`; proj-esbuild and team/proj-numbers `scanned` via `host-local`, proj-npm `unscanned` with `counts: null`; rows: scripts and unbuilt esbuild@0.25.0, deprecated left-pad@1.3.0 (proj-esbuild), outdated-direct is-number@6.0.0 (proj-numbers); no malware, no CVEs, no errors; proj-npm untouched |
| `--root fleet --shadow --format csv` | exit 0, stdout equals `rows.csv`; proj-npm `shadow` via `host-local`, `method: install`, deprecated left-pad@1.3.0 row labelled `shadow`; the shadow dir holds `node_modules package.json vlt-lock.json vlt.json` and its `package.json` is byte-identical; proj-npm has no `vlt-lock.json`, no `node_modules/.vlt`, unchanged `package-lock.json` |
| `--root fleet --root fleet2 --format table` | exit 0; both `proj-numbers` projects `scanned`, one `host-local`, one `host-file`; outdated-direct counts 1 (team) and 0 (fork) |
| Cross-implementation | `rows` and `projects` identical; table output and `summary.csv` byte-identical across sh, nu and ts |
| repo scratch | no `fleet-scan.*` directories left in `<repo>/.tmp` |

Table output from the two-root run (sh, 67-check run):

```
PROJECT                                         STATUS   QUERY            PACKAGE    VERSION
/tmp/vlt-lab-06.ryz29j/fleet/proj-esbuild       scanned  scripts          esbuild    0.25.0
/tmp/vlt-lab-06.ryz29j/fleet/proj-esbuild       scanned  unbuilt          esbuild    0.25.0
/tmp/vlt-lab-06.ryz29j/fleet/proj-esbuild       scanned  deprecated       left-pad   1.3.0
/tmp/vlt-lab-06.ryz29j/fleet/team/proj-numbers  scanned  outdated-direct  is-number  6.0.0

PROJECT                                          STATUS     VIA         MALWARE  CVES  SCRIPTS  UNBUILT  OUTDATED-DIRECT  DEPRECATED
/tmp/vlt-lab-06.ryz29j/fleet/proj-esbuild        scanned    host-local  0        0     1        1        0                1
/tmp/vlt-lab-06.ryz29j/fleet/proj-npm            unscanned  -           -        -     -        -        -                -
/tmp/vlt-lab-06.ryz29j/fleet/team/proj-numbers   scanned    host-local  0        0     0        0        1                0
/tmp/vlt-lab-06.ryz29j/fleet2/proj-numbers-fork  scanned    host-file   0        0     0        0        0                0
```

One scan of this fleet with six queries took 2.2 seconds without `--shadow` and 4.6 to 4.9 seconds with it (one shadow install), measured with `time` during development.

## Known limits

- **Only vlt-installed projects are visible to vlt.** Everything else is `unscanned` unless `--shadow` is used.
- **Shadows resolve fresh.** A shadow copy has only `package.json`, so vlt resolves current versions from its ranges. The shadow can differ from what the project's own lockfile installed; treat shadow rows as an approximation. Workspaces, `.npmrc` routing and private scopes of the original are not carried over.
- **Same-name collision.** `:host(local)` keeps one project per package name in 1.3.6. The fallback adds one `vlt query` process per affected project and query.
- **Discovery is reimplemented.** fleet-scan walks the roots itself to find `unscanned` projects, mirroring vlt's rules as read from the 1.3.6 bundle. If a later vlt changes its walker, the two lists can diverge; projects vlt reports that the walker missed are still included (`name: null`).
- **`:outdated` needs the registry and security selectors need `api.socket.dev`.** Offline, those queries fail and are listed in `errors` (exit 1).
- **`--out` inside a root.** The walker skips the output directory, but vlt's own walker may also discover shadow copies through a root that contains `--out`. Rows are deduplicated, so results stay correct; keep `--out` outside the roots or under a dot directory (the default `<repo>/.tmp` is one).
- **Multiple `--root` flags in nu.** The nu entrypoint parses its own argv (`def --wrapped main`) so that `--root` can repeat like in sh and ts; `nu fleet-scan.nu --help` prints the usage line rather than nu's generated help.
- **shellcheck** is not installed here; the sh files pass `dash -n` only.
