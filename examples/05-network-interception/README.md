# 05 network interception

Two ways to make an install use the registry a profile names, for the cases where configuration alone is not enough. Both work on one command at a time and leave the host unchanged.

| | [a-enforce-allowlist](a-enforce-allowlist/README.md) | [b-tls-redirect](b-tls-redirect/README.md) |
|---|---|---|
| Question it answers | "Is this command talking only to the registry I chose?" | "Can this command use my registry although it insists on registry.npmjs.org?" |
| Mechanism | nono sandbox: outbound network limited to the profile's hosts (proxy allowlist for remote hosts, Landlock port grant for loopback) | private mount namespace with its own `/etc/hosts`, plus a Bun TLS terminator with a per-session CA that forwards to the profile's npm URL |
| A client that ignores its config | fails fast (`403 ... not in the allowlist`) | is served from the profile's registry |
| Lockfiles with `registry.npmjs.org` URLs | their tarball requests are refused under a non-npmjs profile | install as written; packument tarball URLs are rewritten back to the requested host, so lockfiles stay byte-stable |
| Evidence it produces | nono's refusals | a request log with the final upstream URL of every packument and tarball |
| Needs | nono 0.79, Landlock | openssl, Bun, `unshare` (root, or unprivileged user namespaces plus port 443) |
| Status | built, `test.sh` green (2026-10-04) | built, `test.sh` green (2026-10-04) |

They compose. `a` proves that nothing leaves for an unlisted host; `b` makes the hardcoded host point at the chosen registry. Wrapping a redirected run in the enforcer needs the enforcer to allow the terminator's loopback address and the upstream's hosts; that combination was not built or tested here (`not run`).

Choosing between them:

- Use **a** in CI to catch drift: a new tool, a stray `--registry`, or a lockfile that still points at npmjs fails loudly.
- Use **b** to move an existing project to another registry (the vlt-hosted mirror, the Cloudflare gate, vsr) without regenerating npm, yarn or bun lockfiles, or to observe exactly which packuments and tarballs an install fetches.

## Results

See each subdirectory. Highlights from 2026-10-04:

- a: under profile `gate-local`, `npm install left-pad --registry https://registry.npmjs.org/` was refused in about 1 s; under `npmjs` it installed.
- b: `npm ci` from an npmjs-pinned lockfile installed through the terminator; with `--upstream https://registry.npmmirror.com/` every tarball came from npmmirror's CDN while the lockfile stayed unchanged; npm, pnpm, yarn classic, bun and vlt were all redirected. yarn classic needed `npm_config_https_proxy` unset, because it ignores `NO_PROXY`.

## Known limits

- Both are Linux-only as built here (nono's Landlock mode, mount namespaces).
- Neither covers hosts outside the registry profile: git dependencies, GitHub tarballs and security APIs keep their own routing.
