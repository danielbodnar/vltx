# 07 nono sandboxing

Runs package installs as separate phases, each under its own [nono](https://nono.sh) capability sandbox, so that the phase that executes third-party lifecycle scripts has no network, no HOME, no credentials and no shared caches. A harmless hostile fixture (`fixtures/hostile-postinstall`) proves the boundaries, and an unsandboxed run of the same build shows what the sandbox prevents.

## Phase model

```
            config/registry.profiles.json  (render target `hosts`, `env-sh`)
                              |
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
   +-------------+     +-------------+     +--------------+
   |   fetch     | --> |   query     | --> |    build     |
   | vlt install |     | vlt query   |     | vlt build    |
   | vlt ci      |     | :malware    |     | (postinstall |
   |             |     |             |     |  scripts run)|
   +-------------+     +-------------+     +--------------+
   net : registry      net : registry      net : none (seccomp, TCP+UDP)
         hosts only          hosts +
         (proxy 403          api.socket.dev
          for others)
   fs  : project rw    fs  : project ro    fs  : project rw
         vlt cache rw        vlt cache rw        per-run cache holding only
         keychain ro                             security-archive.db
                                                 no HOME, no /tmp
   env : VLT_TOKEN     env : no tokens     env : allow-list, no tokens
   code: vlt only      code: vlt only      code: third-party (assume hostile)

   npm / pnpm / bun:   npm-fetch (install --ignore-scripts)  -->  native-build (npm|pnpm rebuild)
   any command:        run  (network limited to the profile hosts; used by 05/a-enforce-allowlist)
```

The query phase must run before the build phase: `vlt build`'s default target `:scripts:not(:built):not(:malware)` reads `<cache>/vlt/security-archive.db`, and with the network blocked a missing entry makes the build fail closed (observed: `getaddrinfo EAI_AGAIN api.socket.dev`).

## Files

| File | Purpose |
|---|---|
| `phases.json` | The phase table read by all three wrappers: nono profile, command per tool, network mode, extra hosts, dirs to create, cache isolation |
| `profiles/*.jsonc` | nono profiles, commented grant by grant |
| `sandbox-phase.sh` / `.nu` / `.ts` | Compose and run one phase (identical command lines, checked by `test.sh`) |
| `prove.sh` | End-to-end proof against the hostile fixture; writes `results/proof-<date>.json` |
| `test.sh` | Profile validation, wrapper parity, guard rails, then `prove.sh` |

## Usage

```sh
cd my-project                       # must contain vlt.json (an empty {} is enough)
sh  examples/07-nono-sandboxing/sandbox-phase.sh fetch            # vlt install
sh  examples/07-nono-sandboxing/sandbox-phase.sh query            # vlt query :malware --view=count --expect-results=0
sh  examples/07-nono-sandboxing/sandbox-phase.sh build            # vlt build, strict
nu  examples/07-nono-sandboxing/sandbox-phase.nu build --permissive
bun examples/07-nono-sandboxing/sandbox-phase.ts npm-fetch --tool pnpm
sh  examples/07-nono-sandboxing/sandbox-phase.sh native-build --tool pnpm
sh  examples/07-nono-sandboxing/sandbox-phase.sh fetch --profile vlt-hosted --dry-run
sh  examples/07-nono-sandboxing/sandbox-phase.sh fetch --exec -- vlt ci
```

Flags: `--profile` (registry profile; default `$VLT_LAB_PROFILE`, then `npmjs`), `--project DIR` (default cwd), `--tool npm|pnpm|bun`, `--permissive` (build only), `--exec` (args after `--` replace the phase command), `--read DIR` / `--allow DIR` (repeatable extra grants, for example a `file:` dependency outside the project), `--verbose` (nono banner and diagnostics), `--dry-run` (print the composed command). Args after `--` replace the phase's default args.

What a wrapper composes, in order: the phase's profile file; `--allow-cwd` with the project as cwd; one `--allow-domain` per registry profile host plus the phase's extra hosts; `--open-port PORT` and `--sandbox-policy landlock` for loopback hosts; `--upstream-proxy` from `HTTPS_PROXY` when set, with `--upstream-bypass` for allowed hosts that match `NO_PROXY`; `--read-file` for `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`; `--read` for the node prefix and the tool's package directory (resolved through symlinks, nested entries dropped); the user's `--read`/`--allow`. It exports the registry profile environment (`VLT_REGISTRIES`, `npm_config_registry`, ...) and explicit `XDG_*` dirs, creates the grant directories (nono silently skips grants for missing paths), and for `build`/`native-build` points `XDG_CACHE_HOME` at a fresh per-run directory seeded with `vlt/security-archive.db`, removed afterwards.

Example (`fetch`, npmjs, this machine):

```
nono run -s --profile profiles/vlt-fetch.jsonc --allow-cwd \
  --allow-domain registry.npmjs.org --upstream-bypass registry.npmjs.org \
  --upstream-proxy 127.0.0.1:43455 --read-file /root/.ccr/ca-bundle.crt \
  --read /opt/node22 --read /home/claude/.npm-global/lib/node_modules/vlt -- vlt install
```

## Profiles

The built-in `default` profile is always merged underneath every profile, so `deny_credentials` (`~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.docker`, ...), `deny_shell_configs`, `deny_shell_history` and the system read groups apply everywhere. nono resolves `extends` by name only (a file path fails with `invalid base profile name`), so profiles that share content repeat it.

| Profile | Workdir | Filesystem | Network | Environment | Other |
|---|---|---|---|---|---|
| `vlt-fetch` | rw (node_modules, lockfiles) | `$XDG_CACHE_HOME/vlt` rw; `$XDG_CONFIG_HOME/vlt`, `$XDG_DATA_HOME/vlt` (keychain) ro | proxy; sentinel host `vlt-lab-no-hosts.invalid` so a run without `--allow-domain` denies everything | allow-list incl. `VLT_*` (registry config and `VLT_TOKEN`) and CA vars | `sandbox_policy: landlock`; `VLT_STORE_LINKER=copy` |
| `vlt-query` | ro (observed: vlt query writes nothing in the project) | `$XDG_CACHE_HOME/vlt` rw (SQLite needs the directory for journals); `$XDG_CONFIG_HOME/vlt` ro | proxy + sentinel; wrapper adds `api.socket.dev` | allow-list; `VLT_TOKEN*`, `VLT_OTP` denied | `sandbox_policy: landlock` |
| `vlt-build` (strict) | rw | per-run `$XDG_CACHE_HOME/vlt` rw; `$XDG_CONFIG_HOME/vlt` ro; `system_write_linux` excluded (no `/tmp`), device nodes re-added | `block: true` | allow-list; `VLT_TOKEN*`, `VLT_OTP` denied | default command groups kept |
| `vlt-build-permissive` | rw | as strict, but `/tmp` and `$TMPDIR` writable | `block: true` | as strict | `commands.allow`: cp, mv, rm, rmdir, chmod, chown, chgrp, truncate, xargs, npm |
| `npm-fetch` | rw | `$XDG_CACHE_HOME/{npm,pnpm,bun}` rw (caches redirected there by `set_vars`) | proxy + sentinel | allow-list incl. `npm_config_*`, `VLT_TOKEN`; host proxy vars (`npm_config_https_proxy`, `npm_config_noproxy`, ...) denied | `commands.allow: npm`; landlock; `npm_config_ignore_scripts=true` |
| `native-build` | rw | per-run `$XDG_CACHE_HOME/npm` rw; `/tmp` writable for node-gyp and compilers | `block: true` | allow-list; tokens and proxy vars denied | `commands.allow: npm`; `npm_config_ignore_scripts=false`, `npm_config_offline=true` |
| `net-only` | rw | package-manager caches under `$XDG_CACHE_HOME` | proxy + sentinel | inherited, minus host proxy vars | for `run`; egress control only |

Why the less obvious grants exist:

- **Sentinel `allow_domain`.** Any `allow_domain` entry starts nono's proxy, and in proxy mode every host that is not allowlisted gets HTTP 403. Without it, running a fetch profile by hand without `--allow-domain` would fall back to nono's default of unrestricted network. Observed: sentinel only gives CONNECT 403 for registry.npmjs.org.
- **`sandbox_policy: landlock` for fetch and query.** See the rate-limit finding below. Landlock still limits TCP to nono's proxy port; UDP is not filtered, which matters only in phases that run no package code.
- **Isolated build cache.** `vlt build` needs write access to `security-archive.db`. Granting `$XDG_CACHE_HOME/vlt` itself would expose the global store (`<cache>/vlt/store`) to every postinstall script. The wrapper copies only that file into a per-run directory; vlt also writes `package-info/` there, which is discarded.
- **`VLT_STORE_LINKER=copy` in fetch.** By default on Linux, node_modules files are hardlinks into the global store, so any in-place edit inside the project (which the build phase must allow) edits the store for every project. Observed: link count 2 with the default linker, 1 with `copy`.
- **Build env allow-list.** nono passes the whole parent environment unless `environment.allow_vars` is set. `VLT_*` stays allowed (vlt exports its config to scripts as `VLT_*`) with the credential names denied.

### Which build profile esbuild@0.25.0 needs

The strict one. Its postinstall (`node install.js`) built under `vlt-build.jsonc` and the resulting binary ran inside the sandbox (`esbuild --version` = `0.25.0`). The `dangerous_commands` groups are not a factor: in nono 0.79 they only check the command nono starts directly (`vlt`), and nono itself says so when it blocks one: `Command blocking is deprecated in v0.33.0 and only checks the directly-invoked startup command. Child processes can bypass it.` Observed: `nono run --profile vlt-build.jsonc -- cp a b` is refused, `-- sh -c 'cp a c && chmod 600 c && mv c d && rm d'` succeeds. The permissive profile is for toolchains that need `/tmp`, and for starting `npm` or a file utility directly.

What esbuild does need is its optional platform package (`@esbuild/linux-x64`) from the fetch phase. Under nono's default `auto` policy that package was silently missing (next section), and the postinstall then fell back to `npm install` and a direct download, both blocked.

## Results

Observed 2026-10-04 on Linux 6.18.44 (Landlock V6), nono 0.79.0, vlt 1.3.6, Node 22.22.0, npm 10.9, pnpm 10.28, bun 1.4.2. Command: `sh test.sh`, which validates the 7 profiles, checks 11 wrapper parity cases and 12 guard-rail refusals, then runs `prove.sh` with each driver. Records: `results/proof-2026-10-04.json` (sh driver: 30 passed, 0 failed, 2 informational), `proof-2026-10-04-nu.json` and `-ts.json` (`--skip-esbuild`: 26 passed, 0 failed, 1 informational each).

| Check | Expected | Observed |
|---|---|---|
| fetch: `vlt install` under vlt-fetch | exit 0 | exit 0 |
| fetch: `curl https://registry.yarnpkg.com/` | proxy 403 | CONNECT 403 (curl exit 56) |
| fetch: `curl https://registry.npmjs.org/left-pad` | 200 | 200 |
| fetch: node_modules hardlinks | link count 1 | 1 |
| query: `vlt query ':malware' --expect-results=0` | exit 0 | exit 0, `security-archive.db` written |
| build (strict): `vlt build` | exit 0 | exit 0 |
| postinstall reads `$HOME/.ssh/id_canary`, `$HOME/.config/vlt-lab-canary/token` | denied | EACCES |
| postinstall writes `$HOME/.bashrc.canary` | denied | EACCES, file absent |
| postinstall POSTs canary (fetch, proxy CONNECT, spawned curl) to exfil.invalid.example and registry.yarnpkg.com | all fail | 0 of 6 (EAI_AGAIN; HTTPS_PROXY stripped; curl exit 6) |
| postinstall writes `/tmp/...` | denied | EACCES |
| postinstall writes inside its package dir | allowed | allowed |
| `VLT_TOKEN` and other token-like names in the script env | absent | absent |
| build (permissive) | /tmp allowed, rest denied | write-tmp allowed; reads, HOME write, network denied; no token |
| npm-fetch: `npm install --ignore-scripts` | exit 0, no script | exit 0, postinstall did not run |
| native-build: `npm rebuild` | same denials as build | reads, HOME write, network denied; project write allowed; no token |
| plain `nono run` (no profile) passes `VLT_TOKEN` | passes | passes (nono does not filter env by default) |
| contrast, no nono: canary reads | succeed | succeed |
| contrast, no nono: `$HOME/.bashrc.canary`, `/tmp` write | succeed | succeed |
| contrast, no nono: `VLT_TOKEN` in script env | present | present |
| contrast, no nono: network (info) | reachable | registry.yarnpkg.com answered HTTP 405 to all three methods; exfil.invalid.example did not resolve |
| esbuild@0.25.0: fetch, query, strict build, `esbuild --version` | 0.25.0 | `@esbuild/linux-x64` installed; build exit 0; 0.25.0 |
| esbuild@0.25.0 fetch with `--sandbox-policy auto`, empty cache (info) | | exit 0 but 0 platform packages |
| real HOME has no `.bashrc.canary` | absent | absent |

Also observed while building this (not part of `prove.sh`): pnpm 10 and bun through `npm-fetch` / `native-build` (`--tool pnpm`, `--tool bun`) gave the same denials; `vlt ci` runs under the fetch profile via `--exec -- vlt ci`; `vlt query` without a sandbox writes nothing inside the project.

## Surprises (with evidence)

1. **nono's seccomp connect rate limiter drops parallel connections, and vlt hides it.** Under the default `auto` policy, proxy mode adds seccomp user notification on every `connect()`. With `nono run -vv`, one `vlt install esbuild@0.25.0` (esbuild lists 25 optional platform packages, fetched in parallel) logged 14 `Rate limited network seccomp notification, denying` lines against 5 allowed proxy CONNECTs; vlt treats the failed fetches as unavailable optional dependencies and exits 0 without `@esbuild/linux-x64` (reproduced by the `esbuild-fetch-auto` row in every proof run). `--fetch-retries=8` did not help. `linux.sandbox_policy: "landlock"` (or `--sandbox-policy landlock`) removes the notification layer; all manifests then load. The `diagnostics.network_denial_audit` knob described in nono's docs is rejected by 0.79.0 (`unknown field network_denial_audit`).
2. **vlt walks up to an ancestor `vlt.json`.** In a directory without `vlt.json` under this repo, `vlt install` installed into the repo root (it rewrote `/home/claude/vlt-lab/vlt-lock.json`; restored from the committed blob). The wrappers refuse vlt phases when the project has no `vlt.json`, and the fixture app carries an empty `{}` one, which is enough to anchor it.
3. **vlt runs `file:` directory dependencies in place.** `node_modules/evil-pkg` is a symlink to `../../evil-pkg`, the postinstall runs with that real directory as cwd, and vlt sets no `INIT_CWD`. Installing needs `--read` on the dependency directory and building needs `--allow` (npm sets `INIT_CWD` to the project, so the npm flow logs there).
4. **`vlt build` needs api.socket.dev unless the security archive is warm**, because of the `:not(:malware)` default target. It fails closed with the network blocked, which is the desired direction.
5. **`dangerous_commands` is startup-only** (see above). It neither protects against nor obstructs build scripts.
6. **nono skips the `/tmp` grant when HOME is under `/tmp`** (`Skipping Linux system temp grant '/tmp' ... because HOME ... is nested inside it`). Keep test HOMEs out of `/tmp`; `prove.sh` uses `<repo>/.tmp`.
7. **Host proxy variables leak around nono's proxy.** This machine exports `npm_config_https_proxy` and `npm_config_noproxy=...registry.npmjs.org...`; npm would use them instead of nono's injected `HTTPS_PROXY`. The npm profiles deny them. nono injects its own `HTTPS_PROXY`, `NO_PROXY=localhost,127.0.0.1` and `NODE_USE_ENV_PROXY=1` after filtering, so denying `*PROXY*` does not remove nono's.
8. **pnpm 10 `rebuild` skips unapproved build scripts** silently; the pnpm `native-build` command adds `--config.dangerously-allow-all-builds=true`, which is acceptable only because the phase is sandboxed.
9. **nono writes audit and session records to `$XDG_STATE_HOME/nono`** (the command argv, not the environment; a test token value did not appear in them).

## Known limits

- Linux only as tested. Landlock ABI matters: `sandbox_policy: landlock` with network rules needs ABI V4+ (Linux 6.7+) and fails at startup on older kernels; WSL2 (ABI V3) cannot do proxy filtering at all. macOS Seatbelt behaviour (no per-port filtering, different `/tmp` and system paths) is untested here.
- In landlock mode the fetch and query phases do not filter UDP, so DNS is open in those phases. Only vlt or the package manager runs there; lifecycle scripts never do.
- Landlock port grants are not IP scoped: `--open-port 8787` for a loopback registry allows TCP 8787 to any address.
- The build phase allows writes anywhere in the project, including other packages under node_modules. `VLT_STORE_LINKER=copy` keeps that from reaching the global store, but a hostile script can still tamper with its siblings in this project.
- `native-build` with node-gyp needs headers that are normally downloaded at build time; with the network blocked they must already be in the node-gyp cache (not covered here).
- The fetch phase passes `VLT_TOKEN`; a vlt-hosted `.npmrc` for npm needs `${VLT_TOKEN}` auth lines that the env-only composition does not write.
- Toolchain detection grants the node prefix and the tool's package root. Tools installed elsewhere (or binaries in `/usr/local/bin` that read files outside it) need `--read`.
- `prove.sh` posts a fake canary string to registry.yarnpkg.com in the unsandboxed contrast run.

## References

- nono documentation, `docs/cli/features/` in the nono source: networking, environment, profile-authoring, dangerous-command-blocking (nolabs-ai, 2026).
- vlt documentation: client commands build, query, cache (global store and `store-linker`), and `docs/research/vlt-1.3.6-facts.md` in this repo (vlt, 2026).
