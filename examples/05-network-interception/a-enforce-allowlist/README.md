# 05/a enforce-allowlist

Enforces a registry choice without redirecting anything. `enforce` runs any command under nono with outbound network limited to the hosts of one registry profile (render target `hosts` of `config/registry.profiles.json`). A client that ignores its configuration and reaches for the public registry gets refused immediately, instead of silently installing from the wrong place.

## How it works

`enforce.sh`, `enforce.nu` and `enforce.ts` are thin wrappers over the `run` phase of [`examples/07-nono-sandboxing`](../../07-nono-sandboxing/README.md) (profile `net-only.jsonc`), which owns the composition:

| Registry profile host | nono flags | Why |
|---|---|---|
| remote, e.g. `registry.npmjs.org` | `--allow-domain registry.npmjs.org` | nono's proxy allows CONNECT to listed hosts and answers 403 for every other host |
| loopback with port, e.g. `127.0.0.1:8787` (gate-local) | `--open-port 8787 --sandbox-policy landlock` | see below |
| none of the above | nothing | the profile's sentinel host `vlt-lab-no-hosts.invalid` keeps the proxy on, so everything gets 403 |

Plus `--upstream-proxy` from `HTTPS_PROXY` when set (with `--upstream-bypass` for allowed hosts in `NO_PROXY`), `--read-file` for CA bundles, and the registry profile's environment (`npm_config_registry`, `VLT_REGISTRIES`, ...). Host proxy settings that would route a client around nono (`npm_config_https_proxy`, `npm_config_noproxy`, `YARN_*PROXY*`, `GLOBAL_AGENT_*`) are stripped by the profile.

### Loopback hosts and nono

Observed with nono 0.79.0 on Linux, with a listener on 127.0.0.1:8787:

- `--allow-domain 127.0.0.1:8787` alone does not help. nono sets `NO_PROXY=localhost,127.0.0.1` in the sandbox, so clients connect directly instead of through the proxy, and the direct connect is denied (curl exit 7). Forcing the request through the proxy (`env -u NO_PROXY curl -x $HTTP_PROXY`) does work: the proxy forwards plain HTTP to an allowlisted `127.0.0.1` or `127.0.0.1:8787`, and answers 403 for `localhost:8787` unless `localhost` is the listed name.
- `--open-port 8787` under the default `auto` policy is not enough while the proxy is active: `nono run -vv` shows `Proxy seccomp: denying network syscall nr=42 to family=2 port=8787 loopback=true`.
- `--open-port 8787` with `--sandbox-policy landlock` works: Landlock grants TCP connect to port 8787, the proxy still handles every remote host.
- `--block-net --open-port 8787` also works when there is no remote host at all, but nono rejects `--block-net` together with any `allow_domain` (`--block-net and --allow-domain are contradictory`), which the shared profile has. So the wrapper always uses the landlock variant for loopback hosts.

## Usage

```sh
sh  enforce.sh --profile gate-local -- npm install left-pad --registry https://registry.npmjs.org/   # refused
sh  enforce.sh --profile npmjs      -- npm install left-pad --registry https://registry.npmjs.org/   # works
nu  enforce.nu --profile npmjs --project ../my-app -- pnpm install
bun enforce.ts --profile gate-local --dry-run -- npm install left-pad                                # print the nono command
```

Flags: `--profile REGISTRY_PROFILE` (default `$VLT_LAB_PROFILE`, then `npmjs`), `--project DIR` (cwd for the command, read-write in the sandbox; default cwd), `--dry-run`, `--verbose`, `--read DIR` / `--allow DIR`. Everything after `--` is the command.

`sh test.sh` runs the checks below in a scratch dir with a temporary HOME and XDG dirs.

## Results

Observed 2026-10-04, Linux 6.18.44 (Landlock V6), nono 0.79.0, npm 10.9, Node 22.22. Command: `sh test.sh`, all checks passed.

| Check | Expected | Observed |
|---|---|---|
| `enforce.{sh,nu,ts} --dry-run` for gate-local and npmjs | identical command lines | identical |
| gate-local composition | `--open-port 8787`, `--sandbox-policy landlock`, no `--allow-domain` | as expected |
| gate-local: `npm install left-pad --registry https://registry.npmjs.org/` | fails fast, nothing installed | exit 1 in about 1 s: `npm error 403 403 Forbidden: host registry.npmjs.org:443 is not in the allowlist - GET https://registry.npmjs.org/left-pad`; no node_modules |
| npmjs: the same command | installs | exit 0 in about 1 s, `node_modules/left-pad` present |
| gate-local, nothing listening on 8787: `npm install left-pad --fetch-retries=0` (registry from the profile) | connection attempted | `ECONNREFUSED 127.0.0.1:8787`, which shows the port is open in the sandbox |
| gate-local with throwaway listeners on 8787 and 8788 | only 8787 reachable, public hosts blocked | 8787: HTTP 200; 8788: no connection (curl exit 7); registry.npmjs.org: proxy CONNECT 403 |

With npm's default retries (2, backoff from 10 s), the `ECONNREFUSED` case took 71 s before failing; the 403 case fails on the first request because npm does not retry it.

## Known limits

- Enforcement covers network egress only. `net-only.jsonc` keeps nono's default filesystem rules plus the project and the package-manager caches; it is not meant to contain hostile install scripts (use the 07 phase split for that).
- Landlock port grants are not IP scoped: `--open-port 8787` permits TCP 8787 to any address, not just 127.0.0.1. In landlock mode UDP is not filtered.
- Loopback detection is by name (`localhost`, `127.*`, `::1`); a registry reached through another local alias or a LAN address goes through the proxy like any remote host.
- A host without an explicit port that resolves to loopback gets `--open-port 80`; HTTPS on 443 for a loopback registry needs the profile URL to carry the port.
- Linux behaviour only. On macOS nono's Seatbelt rules allow `localhost:PORT` differently and per-port filtering of outbound traffic is not available; untested here.
- Domain filtering needs `nono run` (supervised). `nono wrap` cannot run the proxy.
