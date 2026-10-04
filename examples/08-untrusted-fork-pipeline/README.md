# 08 untrusted fork pipeline

`fork-install` installs a repository you do not trust with one command. It clones or copies the repository into a fresh scratch directory with git hooks, submodules and package-manager config neutralized, rewrites any `vlt.json` it brought along, and then runs the phases of example 04 (`vlt-install-any`) one by one inside the matching nono sandbox of example 07 (`sandbox-phase`). The result is one JSON report that joins 04's install report with a per-phase sandbox record (profile file, exit code, duration, and the network decisions nono logged), plus a short summary table on stderr.

The pipeline composes the two examples without changing them. 04 provides the phase logic and the state-file contract; 07 provides the sandbox for each phase; 08 adds acquisition, config neutralization, the wiring between them and the merged report.

## Pipeline

```
 <git-url | path>
        |
        v
 +-------------+  git -c core.hooksPath=/dev/null -c protocol.file.allow=never ... clone --depth 1
 | acquire     |    --single-branch --no-recurse-submodules [--branch REF]   (or cp -R for a path)
 | host        |  record commit, then remove .git, node_modules and symlinks that leave the tree;
 |             |  move .npmrc .yarnrc .yarnrc.yml bunfig.toml .pnpmfile.cjs .pnpmfile.mjs aside;
 |             |  rewrite vlt.json to {workspaces, catalog, catalogs, modifiers} (or write {})
 +-------------+
        |
 +-------------+  04 phase detect: reads files, asks `vlt config location`
 | detect host |
 +-------------+
        |
 +-------------+  07 fetch sandbox --exec--> 04 phase fetch
 | fetch       |    vlt install --allow-scripts=':not(*)'      (vlt ci when vlt-lock.json exists)
 | vlt-fetch   |  net: registry hosts through nono's proxy   fs: project rw, vlt cache rw, state rw
 +-------------+
        |
 +-------------+  07 query sandbox --exec--> 04 phase gate     (one pair of vlt queries per rule)
 | gate        |  net: registry hosts + api.socket.dev       fs: project ro, vlt cache rw, state rw
 | vlt-query   |  exit 3 (blocked) ends the pipeline here; the build phase never starts
 +-------------+
        |
 +-------------+  07 build sandbox --exec--> 04 phase build    (vlt build --target SELECTOR)
 | build       |  net: none (seccomp)   fs: project rw, per-run cache, state-build rw (copies only)
 | vlt-build   |  no HOME, no /tmp (strict), token-free env; --permissive selects vlt-build-permissive
 +-------------+
        |
 +-------------+  07 query sandbox --exec--> 04 phase report (lockfile checksums, vlt --version)
 | report      |  fork-install then merges acquire + phase records + 04 report
 +-------------+
        |
        v
 <out>/<slug>-<UTC>.json     stdout: the report path     stderr: summary table

 --native:  acquire -> detect -> npm-fetch (07) -> native-build (07) -> report (07 query sandbox)
```

## Files

| File | Purpose |
|---|---|
| `fork-install.sh`, `.nu`, `.ts` | Entrypoints with the same CLI, report and exit codes. Each one drives 07's wrapper and 04's runner written in its own language (`sh sandbox-phase.sh` + `sh vlt-install-any.sh`, `nu` + `nu`, `bun` + `bun`). |
| `sanitize-vlt-json.jq` | The `vlt.json` rewrite, shared by all three entrypoints |
| `fixtures/hostile-config/` | Overlay for the hostile fixture: a `vlt.json` with `allow-scripts: "*"`, `command.*`, an attacker registry, a cache path and `script-shell`; an `.npmrc` that turns scripts back on; a `.pnpmfile.cjs` that records when it runs |
| `test.sh` | Fixture runs for all three entrypoints, canary inspection, parity, a layer check, the real public repo, static checks |
| `results/` | `test-<date>.json` (every check with its observed value, plus timings) and `real-repo-<date>.json` (the report for the public repository) |
| `../../.github/workflows/untrusted-fork.yml` | CI usage on ubuntu-latest (see below) |

## Usage

```sh
sh  examples/08-untrusted-fork-pipeline/fork-install.sh https://github.com/sindresorhus/is
nu  examples/08-untrusted-fork-pipeline/fork-install.nu ../some-checkout --no-build --keep
bun examples/08-untrusted-fork-pipeline/fork-install.ts https://github.com/org/repo --ref v2.1.0 --gate my-gate.json
sh  examples/08-untrusted-fork-pipeline/fork-install.sh ./legacy-app --native
```

| Option | Meaning |
|---|---|
| `--ref REF` | Branch or tag passed to `git clone --branch` (ignored for a local path) |
| `--profile NAME` | Registry profile from `config/registry.profiles.json`, passed to every 04 phase and every 07 wrapper call |
| `--gate FILE` | Gate rules in 04's format (default: 04's `gate.default.json`). The file is copied into the state dir so the query sandbox can read it. |
| `--build SELECTOR` | `vlt build --target` (default `:scripts:not(:built):not(:malware)`) |
| `--no-build` | Run the build phase in its sandbox with 04's `--no-build`, which records what is pending |
| `--permissive` | Use 07's `vlt-build-permissive.jsonc` (writable `/tmp`) for the build phase |
| `--native` | Use 07's `npm-fetch` then `native-build` (tool chosen from 04's detection: pnpm, bun, otherwise npm). No gate runs in this mode. pnpm gets `--ignore-pnpmfile`. |
| `--out DIR` | Report directory (default `<repo>/.tmp/fork-reports`); the file is `<slug>-<YYYYMMDDTHHMMSSZ>.json` |
| `--keep` | Keep the scratch dir (`<repo>/.tmp/fork-install.XXXXXX` with `repo/`, `state/`, `state-build/`, `neutralized/`, `logs/`, `nono/<phase>/`) |

Exit codes: the first non-zero code of acquire, detect, fetch, gate, build; `1` when only the report phase failed. Acquire uses `2` for a refused input (missing path, a source that contains the scratch dir, a `--ref` starting with `-`) and `4` for a failed clone. The other codes are 04's: `2` refused, `3` gate blocked, `4` fetch failed, `5` build failed. The nu entrypoint exits `1` on an unknown flag (Nushell's own parser); the sh and ts entrypoints exit `2`.

### How a phase is composed

Every sandboxed phase is one 07 wrapper call with `--exec`, so 07 supplies the profile, the proxy and host allowlist, the CA files, the per-run build cache and the XDG directories, and 04 supplies the work. For the sh entrypoint the fetch phase is:

```sh
XDG_STATE_HOME=<scratch>/nono/fetch sh examples/07-nono-sandboxing/sandbox-phase.sh fetch \
  --project <scratch>/repo --profile npmjs \
  --read <repo>/lib --read <repo>/config --read <repo>/packages --read <repo>/node_modules \
  --read <repo>/examples/04-vlt-as-installer --read <vlt package dir> \
  --allow <scratch>/state \
  --exec -- sh <repo>/examples/04-vlt-as-installer/vlt-install-any.sh phase fetch \
             --state <scratch>/state --profile npmjs <scratch>/repo
```

The `--read` grants exist because `--exec` replaces the phase command: 07 derives toolchain grants from the command it starts, so the 04 runner, the shared libraries and vlt's package directory have to be granted explicitly (see Composition findings). Each phase gets its own `XDG_STATE_HOME`, which keeps nono's audit session for that phase separate; after the call, `nono audit list --json` and `nono audit show <id> --json` provide the session id and the proxy's allow and deny decisions.

The build phase gets a separate state directory, `state-build/`, holding copies of `detect.json`, `fetch.json` and `gate.json`. Build scripts can write there, so only `build.json`, `build.stdout.json` and `build.stderr.log` are copied back into `state/`, and the records the report is built from stay out of their reach.

### Report

Top level: `schemaVersion`, `tool` (`fork-install`), `implementation`, `generatedAt`, `input` (`source`, `kind` `git|path`, `ref`, `commit`, `slug`), `mode` (`vlt|native`), `options`, `scratch` (`dir`, `kept`), `acquire`, `phases`, `install` (04's report, unchanged), `exit`.

- `acquire`: `exit`, `error`, `gitConfig` (the `-c` settings used for the clone), `removed` (`gitDir`, `nodeModules`, `externalSymlinks[]`), `neutralized[]` (`{file, action: moved|rewritten|created, sha256}`), `vltJson` (`present`, `sha256`, `parseError`, `keptKeys`, `droppedTopLevel`, `droppedConfigKeys`, `dangerousKeys`, `registryHosts[]` as `{key, host}`; values other than registry hosts are never copied).
- `phases.<acquire|detect|fetch|gate|build|report>`: `ran`, `exit`, `startedAtMs` (epoch ms), `durationMs` (wall time including the wrapper), `skipReason` (`acquire-failed`, `detect-failed`, `fetch-failed`, `gate-blocked`, `gate-failed`, `native-mode`, `no-build`), `sandbox` (`null` for host phases, else `{phase, profile, network: proxy|block, auditSession, networkAllowed, networkDenied: [{target, port, count}]}`).

nono 0.79.0 records proxy decisions in its audit log. Filesystem denials (Landlock) and the build phase's blocked sockets (seccomp) leave no audit entry, so `networkDenied` stays empty for the build phase even when every connection attempt failed; the canary log in the tests is the evidence for those.

## Threat model

| Layer | What it stops | What it leaves open | Evidence (test.sh) |
|---|---|---|---|
| Git acquisition (`core.hooksPath=/dev/null`, `--no-recurse-submodules`, `submodule.recurse=false`, `protocol.file/ext.allow=never`, `transfer.fsckObjects=true`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_TERMINAL_PROMPT=0`), then `.git` removed | Hooks from templates or global config during the clone, submodules pulling other repositories or local paths, LFS smudge filters, credential prompts; hooks or config a build script plants in `.git` running later in a kept tree | git parses the remote's objects on the host, outside nono | real repo: cloned at `e9c026c611c1`, `removed.gitDir: true` |
| Acquire clean-up | Symlinks that point outside the tree (removed before detect or report read anything); `.npmrc`, `.yarnrc*`, `bunfig.toml` redirecting registries or re-enabling scripts; `.pnpmfile.cjs/.mjs` code that pnpm runs during install; a committed `node_modules` | The repository's own `package.json` and sources, which are the point of the install | hostile-cfg: `leak -> $HOME/.ssh/id_canary` removed, inner symlink kept, `.npmrc` and `.pnpmfile.cjs` moved, no `pnpmfile-ran.log` |
| `vlt.json` neutralization | `allow-scripts`, `command.install/ci.allow-scripts`, `command.build.target`, `registries`/`registry`/`scoped-registries`, `cache`, `script-shell`, `store-linker` and every other `config` key; unknown top-level keys | `workspaces`, `catalog`, `catalogs`, `modifiers` are kept because they describe the graph, and `modifiers` can change dependency specs the same way `package.json` can | hostile-cfg: 7 dangerous keys recorded, attacker host recorded, project `vlt.json` becomes `{"modifiers": {}}` |
| vlt installs without scripts (04 fetch passes `--allow-scripts=':not(*)'`) | Lifecycle scripts during fetch, including when a hostile `vlt.json` is left in place | Nothing in fetch runs package code, so the fetch sandbox's `VLT_TOKEN` and registry egress are never exposed to it | layer check: hostile `allow-scripts: "*"` kept, no script ran; contrast: plain `vlt install` ran it inside the fetch sandbox with `VLT_TOKEN` present |
| Gate (04 gate under the query sandbox) | Building at all when a block rule fails or errors (fails closed); the default blocks `:malware` | Malware that Socket has not flagged; the repository's own scripts | gate-block: exit 3, rule matched `left-pad`, build phase never started, `:built` count 0 |
| nono fetch and query allowlist | Network to anything except the profile's registry hosts (plus `api.socket.dev` for the gate): other hosts get CONNECT 403; gate and report see the project read-only; the query profile strips `VLT_TOKEN` | DNS (UDP) is open under `sandbox_policy: landlock`; the allowlisted registry itself is reachable | every fixture run: `networkDenied: []`; 07's own proofs cover the 403 path |
| nono build limits (strict) | Reading `$HOME` (canary key and token: EACCES), writing `$HOME` and `/tmp`, any network (fetch, proxy CONNECT, spawned curl all fail), `VLT_TOKEN` and token-like variables in the script env, the shared vlt store (per-run cache) | Writes anywhere in the project, including sibling packages, `vlt.json` and the repository's files; CPU and time; forged build outputs (`build.json`, `node_modules/.vlt-lock.json`) | hostile (sh, nu, ts): script ran inside the build window with `NONO_CAP_FILE` set, every canary attempt denied except the write inside its own package |
| Separate build state dir | Build scripts rewriting `detect.json`, `fetch.json`, `gate.json` or the 04 report inputs | The build phase's own outputs come from a sandbox that ran untrusted code | by construction (`--allow state-build` only) |

## Composition findings in 04 and 07

These were observed while composing the two examples. Neither example was modified.

1. **07's default fetch command runs lifecycle scripts when the project's `vlt.json` allows them.** `phases.json` defines fetch as `vlt install` with no `--allow-scripts`. With the hostile fixture's `vlt.json` set to `{"config":{"allow-scripts":"*"}}`, `sh sandbox-phase.sh fetch --project <app>` exited 0 and evil-pkg's postinstall ran inside the fetch sandbox. Its context record showed `vltTokenPresent: true`, `httpsProxySet: true`, `tokenEnvNames: ["NONO_PROXY_TOKEN", "VLT_TOKEN"]`, and its `/tmp` write succeeded; its proxied POSTs to `exfil.invalid.example` and `registry.yarnpkg.com` got CONNECT 403, and its HOME reads got EACCES. A script in that position can reach the allowlisted registry host with the token in hand. The same tree run through 04's fetch phase (which passes `--allow-scripts=':not(*)'`) ran nothing. 08 relies on 04's flag and also strips the `config` block. A one-line fix in 07 would be `"command": ["vlt", "install", "--allow-scripts=:not(*)"]`.
2. **`--exec` drops vlt's toolchain grant.** 07 grants read access to the package directory of the command it starts plus the `toolchain` entries in `phases.json` (only `node`). With `--exec -- sh vlt-install-any.sh phase fetch ...`, vlt's package directory (`/home/claude/.npm-global/lib/node_modules/vlt` here) is no longer granted, and the 04 phase fails with `vlt-install-any.sh: 223: vlt: Permission denied` (vlt exit 126, phase exit 4). Adding `vlt` to the toolchain of the vlt phases would make `--exec` wrappers work without an explicit `--read`.
3. **`--exec` resolves relative paths against the project.** sandbox-phase starts the command with the project as its working directory, so `--exec -- sh examples/04-.../vlt-install-any.sh` fails with `cannot open ... No such file`. 08 passes absolute paths.
4. **04's phases read and write one state directory.** Wrapping 04's build phase in 07's build sandbox needs `--allow <state>`, which hands build scripts write access to every earlier phase record. 08 gives the build phase a directory of copies. A 04 option for separate input and output directories would make this unnecessary.
5. **nono refuses an `XDG_STATE_HOME` below `/tmp`.** `nono run --allow-cwd --block-net -- ...` with `XDG_STATE_HOME=/tmp/.../state` fails at startup with `Refusing to grant '/tmp' (source: group:system_write_linux) because it overlaps protected nono state root '/tmp/.../state/nono'`. 04's test keeps HOME and XDG dirs in a `mktemp` dir under `/tmp`, so that layout cannot be reused for sandboxed phases; 08's tests live under `<repo>/.tmp` (07 notes the related `/tmp` HOME case).
6. **vlt runs the root project's own lifecycle scripts during `vlt build` and leaves it listed as pending.** For `sindresorhus/is`, the build phase window was 18:30:10.6 to 18:30:13.9 UTC and `distribution/index.js` (output of the root `prepare: npm run build`) was written at 18:30:13.1. vlt's `success` list held only `unrs-resolver`, and 04's `pending` still lists the root importer `file~_d`. 04's `pending` therefore overstates what remains unbuilt for projects with their own `prepare` or `install` scripts.

## CI

`.github/workflows/untrusted-fork.yml` runs on `workflow_dispatch` with a `repos` input (a JSON array of git URLs, one matrix job each), optional `ref`, `profile` and `native`. It uses `permissions: contents: read`, `actions/checkout@v7` (with `persist-credentials: false`), `actions/setup-node@v7` and `actions/upload-artifact@v7` (latest major tags from `git ls-remote` on 2026-10-04). nono is installed from the `v0.79.0` release asset `nono-v0.79.0-x86_64-unknown-linux-gnu.tar.gz` and verified with `sha256sum -c` against `36dfeeb6e8c6a30c43f80ba239e2460af43047c008153af527fdd893c1f02392`, which was computed from the downloaded file here, matches the release's `SHA256SUMS.txt`, and unpacks to a binary identical to the locally verified `nono 0.79.0`. vlt is installed with `npm install -g vlt@1.3.6`. Inputs reach the shell only through environment variables. An optional `VLT_TOKEN` secret is exported only when set. Each job appends the summary table to the job summary and uploads `.tmp/fork-reports/` as `fork-report-<job index>`.

## Results

Observed 2026-10-04 on Linux 6.18.44 (Landlock V6), nono 0.79.0, vlt 1.3.6, Node 22.22.0, Nushell 0.116.0, Bun 1.4.2, with HOME and XDG dirs in the test's scratch dir and a fake `VLT_TOKEN` exported. Command: `sh examples/08-untrusted-fork-pipeline/test.sh`. Final run: **119 passed, 0 failed** in 3 minutes 9 seconds (`results/test-2026-10-04.json`). Two earlier runs the same day passed 114 of 114 and 117 of 117 before more checks were added.

| Case (sh, nu, ts unless noted) | Observed |
|---|---|
| Usage | no source and a missing path exit 2 in all three |
| hostile postinstall (fixture app with evil-pkg vendored at `vendor/evil-pkg`) | exit 0, evil-pkg built under `vlt-build.jsonc`; the canary's first record falls inside the build phase window and outside the fetch window; `NONO_CAP_FILE` is in its env; HOME reads EACCES, HOME write EACCES and `.bashrc.canary` absent, 0 of 6 exfiltration attempts succeeded, `/tmp` write EACCES, write inside its package allowed, no token-like variable present |
| hostile postinstall `--permissive` (sh) | exit 0 under `vlt-build-permissive.jsonc`; `/tmp` write allowed, reads, HOME write, network and token still denied |
| hostile `vlt.json` + `.npmrc` + `.pnpmfile.cjs` + escaping symlink, `--no-build` | exit 0; no canary log and no `pnpmfile-ran.log`; evil-pkg pending; fetch command `vlt install --allow-scripts=:not(*)`; dangerous keys `allow-scripts, cache, command.build.target, command.ci.allow-scripts, command.install.allow-scripts, registries.npm, script-shell`; host `registry.attacker.invalid` recorded; fetch reached only registry.npmjs.org |
| 04 `npm-project` | exit 0, detected npm, `package-lock.json` unchanged, nothing to build |
| 04 `scripts-project` | exit 0, `~npm~esbuild@0.25.0` built, nothing pending; `esbuild --version` run inside the build sandbox prints `0.25.0` (sh) |
| forced gate block (`#left-pad`, severity block) | exit 3, gate blocked with the left-pad match, `phases.build.ran: false` (`gate-blocked`), `install.build: null`, `vlt query ':built'` count 0 |
| `--native` on the hostile overlay | exit 0, `npm-fetch.jsonc` then `native-build.jsonc`, gate skipped; postinstall ran inside the native-build window (the hostile `.npmrc` had been moved, and 07 sets `npm_config_ignore_scripts=true` for fetch); reads, HOME write, network and token denied; `/tmp` write allowed (native-build keeps `/tmp`) |
| Parity | key fields of all six case reports and the canary outcomes are identical across sh, nu and ts |
| Layer check | 04 fetch phase in 07's fetch sandbox with `allow-scripts: "*"` and `command.install.allow-scripts: "*"` kept: exit 0, no script ran. Contrast, plain `vlt install` in the same sandbox: the script ran during fetch with `VLT_TOKEN present=true` and `HTTPS_PROXY set=true` (finding 1) |
| Scratch | no `fork-install.*` dirs left in `<repo>/.tmp`; real HOME has no `.bashrc.canary` |

Wall time per run, final test run (ms; fixture caches warm after the first case):

| Case | sh | nu | ts |
|---|---|---|---|
| hostile | 10711 | 8918 | 7913 |
| hostile-cfg (`--no-build`) | 9325 | 8259 | 8541 |
| npm-project | 10696 | 8945 | 9438 |
| scripts-project | 11480 | 9040 | 9578 |
| gate-block | 4358 | 4291 | 4398 |
| native | 5962 | 5713 | 5432 |

A typical vlt-mode fixture run splits into acquire about 20 ms, detect about 170 ms, fetch 0.45 to 1.9 s, gate 4 to 5.3 s (7 default rules, 14 `vlt query` calls), build 0.5 to 1 s, report about 0.4 s. Each sandboxed phase adds roughly 150 to 450 ms of wrapper overhead over 04's own phase duration (for example fetch 1203 ms against 04's 1015 ms, gate 5333 against 4901), plus the two `nono audit` calls.

### Real public repository

`https://github.com/sindresorhus/is` (a small TypeScript library whose dev tree pulls in `unrs-resolver`, which has a postinstall, and whose own `prepare` runs `npm run build`). Final test run with the sh entrypoint: commit `e9c026c611c1`, **exit 0 in 31.0 s** (28.6 s and 35.1 s in two other runs the same day).

| Phase | Exit | ms | Sandbox | Network (allowed, denied) |
|---|---|---|---|---|
| acquire | 0 | 695 | host | |
| detect | 0 | 149 | host | |
| fetch | 0 | 14153 | vlt-fetch | 64, 0 |
| gate | 0 | 6785 | vlt-query | 1, 0 |
| build | 0 | 3144 | vlt-build | blocked |
| report | 0 | 414 | vlt-query | 0, 0 |

477 packages installed; `.npmrc` (`package-lock=false`) moved aside and `{}` written as `vlt.json`; `unrs-resolver@1.12.2` built under the strict profile; the gate warned on `:cve` and `:vuln("<=high")` (`braces@3.0.3`) and `:squat` (`@asamuzakjp/nwsapi@2.3.9`, `hashery@1.5.1`, `open-editor@6.0.0`), and `:malware` passed. The root `prepare` ran inside the build sandbox (finding 6). Report: `results/real-repo-2026-10-04.json`.

### CI workflow

The workflow was **not run** on GitHub from here. Observed locally: it parses with `Bun.YAML.parse`; its `fork-install` step script, extracted from the YAML and run with bash against a copy of 04's `npm-project`, exited 0, wrote the report and appended the summary table to a `GITHUB_STEP_SUMMARY` file; the `sha256sum -c` line verifies the downloaded asset.

## Known limits

- **git runs on the host.** The clone is hardened (see Threat model) but git itself is outside nono. `--ref` accepts what `git clone --branch` accepts (branches and tags); commit SHAs are not supported.
- **detect runs on the host.** It reads files and runs `vlt config location` after acquire has removed escaping symlinks and rewritten `vlt.json`.
- **Build outputs are untrusted.** `build.json`, vlt's build output, `node_modules` and the lockfiles after the build come from a sandbox that ran third-party code with write access to the project. The report records what that sandbox produced.
- **The repository's own scripts run.** With the default target the root project's `prepare` or `install` script runs in the build sandbox, and 04 still lists the root as pending (finding 6).
- **file: dependencies outside the repository** are outside every grant, so fetch fails for them. The hostile fixture is therefore vendored at `vendor/evil-pkg` in the test copy.
- **`--native`** has no gate, keeps `/tmp` writable during the build, and was tested with npm only (pnpm and bun selection follows 04's detection and 07's tool table).
- **Audit coverage.** nono logs proxy decisions only; Landlock and seccomp denials do not appear in the report.
- **Interrupts.** sh and ts remove the scratch dir on Ctrl-C; the nu entrypoint registers no signal handler, so an interrupted nu run can leave it in `<repo>/.tmp`.
- **Scratch location.** Scratch, nono state and test HOMEs must stay outside `/tmp` (finding 5 and 07's note), so everything lives under `<repo>/.tmp`.
- **Inherited limits** from 04 (fresh resolution from `package.json` ranges, `.npmrc` ignored, gate needs `api.socket.dev`) and 07 (Linux with Landlock ABI V4+, UDP open in proxy phases, build writes anywhere in the project) apply unchanged.
- **shellcheck** is not installed here; the sh files pass `dash -n` only.

## References

- nono documentation: networking, environment, profiles, audit (`nono audit show --json`) (nolabs-ai, 2026). Release `v0.79.0` and `SHA256SUMS.txt` on github.com/nolabs-ai/nono.
- vlt documentation: install, build, query, configuring (`vlt.json`, `allow-scripts`, `command.*`), and `docs/research/vlt-1.3.6-facts.md` in this repository (vlt, 2026).
- Git documentation: `git-config` (`core.hooksPath`, `protocol.<name>.allow`, `transfer.fsckObjects`, `submodule.recurse`) and `git-clone` (Git project, 2026).
- GitHub Actions documentation: workflow `permissions`, `workflow_dispatch` inputs, security hardening for untrusted input (GitHub, 2026).
- Examples 04 (`vlt-install-any`) and 07 (`sandbox-phase`) in this repository.
