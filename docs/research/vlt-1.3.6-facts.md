# vlt facts sheet (docs dump + vlt CLI 1.3.6)

Legend: `(/path)` = doc page in vlt-llms-full.txt. `[CLI 1.3.6]` = verified by running vlt 1.3.6 in a scratch dir with sandboxed XDG dirs. `[SRC 1.3.6]` = read from installed vlt 1.3.6 bundle (/home/claude/.npm-global/lib/node_modules/vlt). `UNCONFIRMED` = not established by docs or CLI. `DOC CONFLICT` = docs disagree with each other or with the CLI.

---

## 1. Config files

- Load order: "The `vlt.json` file in the XDG specified config directory is loaded first. Then, if a `vlt.json` file is present in the root of the current project, the `config` field in that file is layered on top of it." (/client/configuring)
- "Scalar values are overridden by the innermost layer that sets them. Object type values are merged together key by key, with the project file winning on conflict. Set a field, or a key within an object field, to `null` ... to explicitly remove it" (/client/configuring)
- User path: example `~/.config/vlt/vlt.json`; "run: `vlt config location --config=user`" (/client/configuring). On this box: `/root/.config/vlt/vlt.json` [CLI 1.3.6]
- Precedence (registry), lowest to highest: user vlt.json < project vlt.json < `VLT_REGISTRY` env < `--registry` flag (/client/registries)
- "Object type values given via `VLT_*` environment variables or on the command line are merged key by key over the config files, command line winning over environment. ... List values in the environment are newline-delimited, e.g. `VLT_REGISTRIES=$'a=https://a/\nb=https://b/'`." (/client/configuring)
- "No global config file" (equivalent of `$PREFIX/etc/npmrc`) (/client/migration/from-npm)
- Command-scoped config: "Command-specific fields may be set in a nested `command` object that overrides any options defined at the top level" (/client/configuring)
- `vlt config set` writes project vlt.json by default; `--config=user` for user file. Read ops default `--config=all` (merged). (/client/configuring; `vlt help config`)

### Exact JSON shape that works in 1.3.6 [CLI 1.3.6]
- Config options MUST be nested under top-level `"config"`. `vlt config set scoped-registries=@acme=https://r.acme/ registries=npm=https://registry.npmjs.org/` writes:
  ```json
  { "config": { "scoped-registries": { "@acme": "https://r.acme/" }, "registries": { "npm": "https://registry.npmjs.org/" } } }
  ```
- Top-level `{"registries": {...}}` (outside `"config"`) is silently ignored (`vlt config get registries` -> `{}`). [CLI 1.3.6]
- Top-level `{"identity":"corp"}` is ignored; `{"config":{"identity":"corp"}}` works. [CLI 1.3.6]
- Key spelling: `scoped-registries` works. `scope-registries` -> "Unknown config option: scope-registries" (hard error). `scopedRegistries` -> same error. [CLI 1.3.6]; docs: "The config key is `scoped-registries`, not `scope-registries`." (/registry/publishing/vlt)
- `scoped-registries` "keeps the `@`" — `scoped-registries.@acme` (/registry/publishing/vlt)
- Non-config top-level vlt.json keys: `workspaces`, `catalog`, `catalogs`, `modifiers` (top-level accepted; `{"config":{"catalog":...}}` -> "Unknown config option: catalog") [CLI 1.3.6]
- DOC CONFLICT: /client/registries shows `vlt config set` producing top-level `"scoped-registries"`/`"registries"` (no `config` wrapper); /client/auth shows top-level `"identity"`; /client/registries#getting-started shows `vlt setup` writing top-level `"registries"`. 1.3.6 actually writes/needs `"config": {...}` (see above and §2).
- Full list of valid `config` option names in 1.3.6 (from the "Unknown config option" error) [CLI 1.3.6]: access all allow-scripts arch bail before brotli-tarballs cache call color commit config dashboard-root default-registry-alias dry-run editor expect-lockfile expect-results fallback-command fetch-retries fetch-retry-factor fetch-retry-maxtimeout fetch-retry-mintimeout force frozen-lockfile git-host-archives git-hosts git-shallow git-tag-version help identity if-present jsr-registries libc lockfile-only loglevel no-bail no-color node-version os otp package publish-directory recursive registries registry save-config save-dev save-exact save-optional save-peer save-prefix save-prod scope scoped-registries script-shell stale-while-revalidate-factor store-linker tag target telemetry verbose version view workspace workspace-group yes

### Env var form [CLI 1.3.6]
- `VLT_REGISTRY`, `VLT_REGISTRIES` (newline-delimited `name=url`), `VLT_SCOPED_REGISTRIES='@a=https://x/'`, `VLT_DEFAULT_REGISTRY_ALIAS=main` all confirmed via `vlt config pick`.
- `VLT_STORE_LINKER` (/client/configuring); `VLT_TOKEN`, `VLT_TOKEN_<url_sanitized>`, `VLT_OTP` (/client/auth)

### `registry`, `registries`, `default-registry-alias`
- `--registry=<url>`: "There is **no default**. A registry must be configured in `vlt.json`, with this flag, or via the `VLT_REGISTRY` environment variable." (/client/configuring)
- `--default-registry-alias=<name>`: "Precedence is `scoped-registries` > `--registry` > `registries[<default-registry-alias>]`. Defaults to `npm`. The `npm` alias itself has **no built-in URL**" (/client/configuring)
- Install commands (`vlt install`, `vlt update`, `vlt uninstall`, `vlt ci`, `vlx`/`vlt exec`) "additionally require the `registries.npm` alias — or, when `default-registry-alias` is set to something else, the alias it names. A scalar `--registry` / `VLT_REGISTRY` is not enough." Error: "Config Error: Missing npm registry configuration." (/client/registries)
- "A layer that sets any of `registry`, `registries`, or `default-registry-alias` owns selection: the `registry` and `default-registry-alias` it does *not* set are dropped rather than inherited from an outer layer." (/client/configuring)
- "`scoped-registries` and `jsr-registries` are purely additive, so they do not take over selection." (/client/configuring)
- "a project which sets `registries` without also setting `default-registry-alias` gets the default `npm` back, even if your user config points it somewhere else." (/client/registries)
- Built-ins: `npm:` no default URL; `jsr:` = `https://npm.jsr.io/` (override via `jsr-registries`); `gh:` = `https://npm.pkg.github.com/` (override via `registries`) (/concepts/named-registries). `vlt config list` shows `gh=https://npm.pkg.github.com/` and `jsr=https://npm.jsr.io/` by default [CLI 1.3.6]
- `--save-config` persists `--registry`, `--registries`, `--default-registry-alias`, `--scoped-registries`, `--jsr-registries`, `--git-hosts`, `--git-host-archives` given on CLI or `VLT_*` env to project vlt.json after successful install/add/update; conflicting existing value -> `ECONFIG` (/client/configuring, /client/registries)
- Registry consistency: "defaulting every dependency to the same registry where its dependent came from" (/client/registries)
- `registry:` specifier: `vlt install "foo@registry:https://foo.com#foo@1"` (/client/registries)

---

## 2. Named registries & hosted vlt.io registries

- URL format everywhere in docs: `https://registry.vlt.io/<account>/npm/` and `https://registry.vlt.io/<account>/main/` (/client/commands/setup, /registry/dashboard, /registry/publishing/*). `registry.vlt.io` appears 113 times.
- `registry.vlt.sh`: appears NOWHERE in the docs. Only `vlt.sh` hosts mentioned: `https://install.vlt.sh` (install script; /client, /npm-interoperability), `https://docs.vlt.sh/cli` (inside error message text; /client/registries, /client/migration/from-npm), `benchmarks.vlt.sh` (/why-vlt).
- Two registries per account (/registry/dashboard):
  - `main` — "your account's private registry, served at `https://registry.vlt.io/<account>/main/`. Packages published here are scoped to your account slug (`@<account>/...`) and readable only by account members."
  - `npm` — "a secure mirror of the public npm registry, served at `https://registry.vlt.io/<account>/npm/`. It is read-only and populated from `registry.npmjs.org`"
- "The npm mirror always requires a token" (/registry/publishing/ci). Public packages on `main` install with no token (/registry/publishing/*).
- "The account's `npm` mirror serves public packages and is readable by any authenticated account member." (/registry/access)
- Private-account publishes must be scoped `@<slug>/...`, else `403 Forbidden`; tarballs limited to 100 MB; versions immutable; no OIDC trusted publishing ("The vlt registry does not currently support OIDC trusted publishing. Use a service token in CI.") (/registry/publishing)
- Package visibility `public` | `restricted`; `vlt publish --access=public` or `publishConfig.access`; `vlt access set status=restricted @acme/utils` (/registry/publishing)

### `vlt setup [<account>]` (/client/commands/setup)
- Stages `npm` -> `https://registry.vlt.io/<account>/npm/` and `main` -> `https://registry.vlt.io/<account>/main/`; optional browser web-login ("A single token covers every registry on your account"); loops for extra aliases; "Writes the staged aliases into your user `vlt.json` (merging with, not clobbering, existing entries)"; copies a keychain token between `npm`/`main` if only one has one; "`VLT_TOKEN*` environment tokens are never saved".
- Flags: `--config=<user|project>` (default `user`), `--registries=<name=url>`, `--yes` ("Requires `<account>`, no browser auth").
- Actual 1.3.6 write for `vlt setup acme --yes --registries team=https://registry.example.com/` [CLI 1.3.6]:
  ```json
  { "config": { "registries": {
      "npm": "https://registry.vlt.io/acme/npm/",
      "main": "https://registry.vlt.io/acme/main/",
      "team": "https://registry.example.com/" } } }
  ```
  It does NOT write `registry` or `scoped-registries` [CLI 1.3.6]. Keychain file created at `$XDG_DATA_HOME/vlt/auth/keychain.json` (`{}` with --yes) [CLI 1.3.6].
- Manual equivalent (/registry/publishing/vlt):
  ```sh
  vlt config set registry=https://registry.vlt.io/acme/npm/ \
    registries.npm=https://registry.vlt.io/acme/npm/ \
    registries.main=https://registry.vlt.io/acme/main/ \
    scoped-registries.@acme=https://registry.vlt.io/acme/main/
  ```
  -> `{"config":{"registry":"...acme/npm/","registries":{"npm":"...acme/npm/","main":"...acme/main/"},"scoped-registries":{"@acme":"...acme/main/"}}}`
- Explicit alias specifier: `vlt install @acme/my-package@main:@acme/my-package@1.0.0` -> package.json `"main:@acme/my-package@1.0.0"` (/registry/publishing/vlt)

### Auth storage / login / token
- Keychain: "Authentication tokens will be stored in the XDG data directory, in `vlt/auth/${identity}/keychain.json`. If no identity is provided ... `vlt/auth/keychain.json`." Identity: lowercase alphanumeric only (/client/configuring)
- "sensitive information is *only* kept in a tightly restricted keychain file, or in the environment" (/client/auth)
- `vlt login`: "There is no default registry ... On success the registry is written to the project's `vlt.json`". Flags `--registry=<url>`, `--identity=<name>`, `--config=<user|project>` (default `project`) (/client/commands/login)
- "`vlt login --registry=<url>` writes only the scalar `registry` option." (/client/security)
- `vlt logout`: deletes local keychain token and "destroying it on the server" (/client/commands/logout)
- `vlt token list|add|rm`: list queries each registry's token API; `add` prompts to paste a bearer token; `rm` removes local token only (/client/commands/token, /client/auth)
- "`vlt token add` needs an interactive terminal ... piping it in ... fails with `stdin.setRawMode is not a function`. Use `VLT_TOKEN` in scripts." (/registry/publishing/vlt)
- `vlt registry <alias> <command>` for `whoami, logout, login, token, access, publish, unpublish, deprecate, dist-tag, profile, ping` (/client/commands/registry)
- Tokens: prefix `vlt_1_`; personal (OTP on writes; CLI login mints `package:read`+`package:write`) vs service (no OTP; owner/admin only); privileges e.g. `package:read`, `package:write`, `token:read`, `member:write`; "one token works for both of the account's registries (`main` and `npm`)" (/registry/tokens)
- Redirects: token follows same-origin redirects, dropped on origin change (/client/auth)

---

## 3. Using the hosted registry from other clients (slug `acme`)

### npm (verified npm 12) (/registry/publishing/npm)
```ini
registry=https://registry.vlt.io/acme/npm/
@acme:registry=https://registry.vlt.io/acme/main/
//registry.vlt.io/acme/npm/:_authToken=${VLT_TOKEN}
//registry.vlt.io/acme/main/:_authToken=${VLT_TOKEN}
```
- "Use the braces — bare `$VLT_TOKEN` is **not** expanded". Host-wide `//registry.vlt.io/:_authToken=${VLT_TOKEN}` works for npm but "is not portable to bun".
- `npm login --registry=https://registry.vlt.io/acme/main/` (npm 12 defaults `--auth-type=web`); don't pass `--otp` (forces legacy; username/password unsupported).
- Scoped publish order: `@acme:registry` > `--registry` > `publishConfig.registry` > default `registry`.
- /registry/tokens shows variant `//registry.vlt.io/acme/main/:_authToken=${NPM_TOKEN}`.

### pnpm (verified 10, 11, 12) (/registry/publishing/pnpm)
- "pnpm 12 rejects every version in the mirror's metadata and fails with `no version found for the latest tag`" (mirror only); pin `corepack use pnpm@11.26.0`.
- Commit routing only:
```ini
registry=https://registry.vlt.io/acme/npm/
@acme:registry=https://registry.vlt.io/acme/main/
```
- "pnpm **deliberately ignores `${...}` placeholders** in a repository `.npmrc`" (since 11.5.3). Options: `pnpm login --registry=<url> [--scope=@acme]` or env var:
  `env "pnpm_config_//registry.vlt.io/acme/npm/:_authToken=$VLT_TOKEN" pnpm install` (needs pnpm >= 11.6.0).
- Version matrix: <=11.5.2 placeholder works/env unsupported; 11.5.3 neither; 11.6.0–11.26.0 env works; 12.x env works.
- `pnpm config set ... --location=project` (default is global); `publishConfig.registry` is strongest in pnpm; `--no-git-checks` in CI; `pnpm token` not implemented.

### yarn Berry (verified Yarn 4.18) (/registry/publishing/yarn)
```yaml
npmRegistryServer: 'https://registry.vlt.io/acme/npm/'
npmAlwaysAuth: true
npmAuthToken: '${VLT_TOKEN}'
npmScopes:
  acme:
    npmRegistryServer: 'https://registry.vlt.io/acme/main/'
    npmPublishRegistry: 'https://registry.vlt.io/acme/main/'
    npmAlwaysAuth: true
    npmAuthToken: '${VLT_TOKEN}'
    npmMinimalAgeGate: 0
```
- Scope keys without `@`; `npmAlwaysAuth: true` required (else 401) and must be in same block as token; `npmPublishRegistry` mandatory for publish (else goes to `registry.yarnpkg.com`); scope block without `npmRegistryServer` routes to `registry.yarnpkg.com`; `npmMinimalAgeGate` default 1440 min, must be per-scope; Berry "does not read `.npmrc` at all"; unset `${VLT_TOKEN}` is a hard error (use `${VLT_TOKEN:-}`).
- Login: `yarn npm login --web-login --always-auth` (Yarn >= 4.12.0). Publish: `yarn install` then `yarn npm publish`.
- Yarn Classic 1.x: `yarn config set registry ...`, `yarn config set @acme:registry ...`, auth lines in `.npmrc`.

### bun (verified bun 1.4) (/registry/publishing/bun)
```toml
[install]
registry = { url = "https://registry.vlt.io/acme/npm/", token = "$VLT_TOKEN" }

[install.scopes]
acme = { url = "https://registry.vlt.io/acme/main/", token = "$VLT_TOKEN" }
```
- "In `bunfig.toml` bun expands only the unbraced form. The braced form is sent literally and you get a `401`." In `.npmrc` "the braced `${VLT_TOKEN}` form **is** expanded."
- `.npmrc` alternative = same 4 lines as npm. "If both files exist, `bunfig.toml` wins — but only on **bun 1.4 and newer**."
- Gotchas: never omit trailing slash (bun 1.4 drops last path segment); quote `"@acme"` if using `@`; host-wide `//registry.vlt.io/:_authToken` does NOT work in bun; no `bun login`; `publishConfig.registry` alone insufficient for `bun publish`.

### deno (verified deno 2.9) (/registry/publishing/deno)
- `.npmrc` same 4 lines as npm (`${VLT_TOKEN}`; `$VAR` not expanded); `deno install --env-file` to load `.env`.
- 24h age gate: `deno install --min-dep-age=0`, or deno.json `{"minimumDependencyAge":{"age":"P1D","exclude":["npm:@acme/*"]}}` (`npm:` prefix required), or `.npmrc` `min-release-age=0` / `NPM_CONFIG_MIN_RELEASE_AGE=0`.
- Publishing: `deno pack` then `npm publish acme-my-package-1.0.0.tgz`; set `publish.include` to avoid packing `.npmrc`/`bunfig.toml`.
- Unset var sent as literal `${VLT_TOKEN}`; use `${VLT_TOKEN?}` for empty.

### vlt client (verified vlt 1.0) (/registry/publishing/vlt)
- Env: `VLT_TOKEN=<token>` + `VLT_REGISTRY=https://registry.vlt.io/acme/npm/`. "`VLT_TOKEN` alone covers the default registry. If you also use `scoped-registries`, set `VLT_REGISTRY` as well — without it, vlt sends no credentials to the scoped registry."
- Per-registry `VLT_TOKEN_<url with non-alphanumerics -> _>`, e.g. `VLT_TOKEN_https_registry_vlt_io_acme_main` (/registry/tokens). "do **not** apply to registries configured through `scoped-registries`" (/registry/tokens)
- Publish OTP from env: `VLT_OTP=<code> vlt publish` (/registry/publishing/vlt, /client/auth)

### CI (/registry/publishing/ci)
- "Store your token as a secret named `VLT_TOKEN` and export it." GitHub Actions: `env: VLT_TOKEN: ${{ secrets.VLT_TOKEN }}`; publish example uses `secrets.VLT_TOKEN_CI`.
- Per-tool CI commands: `npm ci`; `env "pnpm_config_//registry.vlt.io/acme/npm/:_authToken=$VLT_TOKEN" pnpm install --frozen-lockfile`; `yarn install --immutable`; `bun install --frozen-lockfile`; `deno ci`; `VLT_REGISTRY=https://registry.vlt.io/acme/npm/ vlt install --frozen-lockfile`.
- Publishing from CI: service token ("This is a service token") with `package:read` + `package:write`; personal tokens fail with `npm error code EOTP`.
- Install-only CI token: service token with just `package:read` (/registry/using-packages).
- vlt OIDC: GitHub Actions native (`id-token: write`), GitLab/CircleCI via `NPM_ID_TOKEN`; "The vlt.io registry currently does not" support it (/client/auth).

---

## 4. Install-time security

- `vlt install`: "downloads and extracts packages **without executing lifecycle scripts**" (/client/commands/install). Default `allow-scripts` when unset is `":not(*)"` [SRC 1.3.6 chunk-RAE3LNUK.js].
- `--allow-scripts=<selector>`: "Allow specific packages to run lifecycle scripts during install", e.g. `vlt install --allow-scripts="#esbuild, #node-gyp"`, `--allow-scripts=":root > \*"` (/client/commands/install). Legacy npm behaviour: `vlt install --allow-scripts="*"` (/client/commands/build). `allow-scripts` is a valid `config` key (`{"config":{"allow-scripts":"#esbuild"}}` accepted) [CLI 1.3.6].
- vlx/`vlt exec`/`vlt create` installs use `allowScripts: ":scripts:not(:malware)"` ("allow lifecycle scripts but filter out malware via security archive") [SRC 1.3.6 chunk-IXAHSTBN.js]. Not in docs: UNCONFIRMED by docs.
- `vlt build [query]` / `--target=<query>` (alias `b`): positional and `--target` interchangeable (/client/commands/build).
- Default target: "`:scripts:not(:built):not(:malware)` targetting only not build packages that have lifecycle scripts (or a root `binding.gyp`) and do not have any malware alerts" (/client/commands/build). Confirmed in [SRC 1.3.6 build-BK4ITRPX.js]: `targetOption || targetPositional || ":scripts:not(:built):not(:malware)"`. Note `vlt help build` text says only "(:scripts) by default".
- Persist build target: `vlt config set "command.build.target=<query>"` -> `{"config":{"command":{"build":{"target":"<query>"}}}}` [CLI 1.3.6] (/client/commands/build)
- Build state: "Each package node stores its build state (`needed`, `built`, or `failed`)." (/client/commands/build)
- `vlt ci`: "Removes `node_modules` and installs dependencies exactly as specified in `vlt-lock.json`, failing if the lockfile is missing or out of date." Runs no dependency lifecycle scripts by default. Options: `--allow-scripts=<query>`, `--lockfile-only` (`vlt help ci`). Persist: `vlt config set "command.ci.allow-scripts=#esbuild"` -> `{"config":{"command":{"ci":{"allow-scripts":"#esbuild"}}}}` [CLI 1.3.6]. Typical: `vlt ci && vlt build` (/client/commands/ci)
- Lockfile flags: `--frozen-lockfile` (missing or out of sync with package.json), `--expect-lockfile` (missing or outdated), `--lockfile-only` (/client/commands/install)
- `:scripts` = "Packages with install scripts (postinstall, preinstall, etc.), or marked by install as needing a build (e.g. a root `binding.gyp`)" (/client/selectors/security-insights)
- `:built` = "packages that have been successfully built during the reify process (have `buildState` set to `'built'`)" (/client/selectors/pseudo-states)
- `:malware`: "matches only high-confidence malware alerts (`malware` and `gptMalware`)" binary, no params (/client/selectors/security-insights). DOC CONFLICT: /client/security says it "finds packages with **medium or higher severity** malware alerts (critical, high, medium)"; /client/commands/query example uses `:malware(critical)`.
- Security data: "Security insight selectors rely on data provided by Socket. Using any of these selectors triggers a network call to fetch package report data." (/client/selectors/security-insights). "requires network access ... The first query may take longer as security metadata is downloaded and cached locally." (/client/security)
- Eligibility: "Packages are eligible when their origin is the public npm registry (`https://registry.npmjs.org/`) or whatever URL is configured as `registries.npm` ... Packages from other registries have no security data." (/client/security)
- Cache file: `<cache>/vlt/security-archive.db` created by `:malware` query (here `$XDG_CACHE_HOME/vlt/security-archive.db`) [CLI 1.3.6].
- Auth: `:malware`/`:scanned` worked with empty keychain and no `VLT_TOKEN` for a registry.npmjs.org package (`:scanned` count 1) [CLI 1.3.6]. Docs do not state an auth requirement.
- Fail-install-on-malware config: none documented; no such key in 1.3.6 valid option list [CLI 1.3.6]. Gate pattern from docs: `vlt query ':malware' --expect-results=0` (/client/security). UNCONFIRMED whether `vlt install` itself warns on malware.

---

## 5. `vlt query`

- Usage: `vlt query <query> --view=[human | json | mermaid | svg | png | count]` (/client/commands/query; `vlt help query`). Alias `q`.
- `--view=gui` is INVALID: "Invalid value provided for --view: \"gui\"" [CLI 1.3.6]. Global `--view` lists "human", "json", "mermaid", "count" (/client/configuring).
- "Defaults to human-readable or json if no tty. Use `svg` or `png` to render the dependency graph as an image and open it automatically." `count` "outputs the number of dependency relationships in the result" (`vlt help query`).
- Other flags: `--scope=<query>` (top-level items), `--target=<query>` (alternative to positional) (`vlt help query`).
- Requires a vlt-installed graph: "In a project installed by another client ... the command errors ... `:host()` queries are the exception" (/client/commands/query)
- `--expect-results=<comparison>`: "Exits with error code if expectation is not met." Values `0`, `">0"`, `"<5"`, `">=10"` (/client/commands/query); also `<=` (`vlt help query`). Mismatch -> stderr `Error: Unexpected number of items`, exit code 1; match -> exit 0 [CLI 1.3.6].
- Security insight selectors (exact list, /client/selectors/security-insights):
  - Malware & threats: `:malware`, `:squat` / `:squat(<type>)` (`critical`|`0`, `medium`|`2`, `none`), `:suspicious`, `:confused`
  - Vulnerabilities: `:vulnerable` / `:vuln`, `:vuln(<level>)` (`critical`|0, `high`|1, `medium`|2, `low`|3; comparators e.g. `">=medium"`; parameterless = >= medium), `:cve(<id>)` / `:cve`, `:cwe(<id>)`, `:severity(<level>)`
  - Licensing: `:license(<type>)` (`unlicensed`, `misc`, `restricted`, `ambiguous`, `copyleft`, `unknown`, `none`, `exception`) / `:license`
  - Code behavior: `:eval`, `:network`, `:fs`, `:env`, `:shell`, `:scripts`, `:debug`, `:dynamic`
  - Obfuscation & hiding: `:obfuscated`, `:minified`, `:entropic`, `:native`, `:shrinkwrap`
  - Package health: `:deprecated`, `:unmaintained` (>5 years), `:unpopular`, `:trivial` (<10 LOC), `:abandoned`, `:unknown`, `:unstable`
  - Other: `:tracker`, `:undesirable`, `:score(<rate>, <kind>)` (kinds `overall`, `license`, `maintenance`, `quality`, `supplyChain`, `vulnerability`)
  - Related pseudo-state: `:scanned` = has Socket metadata (/client/selectors/pseudo-states)

---

## 6. `:host()`, `:hostname()`, `:registry()`

- `:host(<context>)`: "switches the current graph context to a new set of graphs loaded from a specific host context". Context = project folder path e.g. `"file:~/my-project"`, or "The special `local` context — loads all configured projects from your vlt dashboard" (/client/selectors/pseudo-classes/host)
- Examples: `vlt query ':host(local) :malware'`; `vlt query ':host("file:~/my-app") :outdated'`; `vlt version patch --scope=':host("file:~/tmp/test-vite")'`; `vlt pkg pick name version --scope=':host(local) > :root > *'` (/client/selectors/pseudo-classes/host); weekly scan `vlt query ':host(local) :is(:malware, :not(:scanned))'` (/client/security)
- `--dashboard-root=<path>`: "The root directory to use for the dashboard browser-based UI. If not set, the user home directory is used. Can be set multiple times" (/client/configuring). Valid `config` key [CLI 1.3.6].
- How `local` discovers projects [SRC 1.3.6 chunk-WS7BNE5S.js, not in docs]: walks `dashboard-root` paths (default: home dir) up to depth 7; skips symlinks, `node_modules`, dot-dirs, and in home: downloads, movies, music, pictures, private, library, dropbox (+ videos, public on Linux); any dir with a regular `package.json` is a project (no descent below it); `local` includes only projects where `isVltInstalled` is true. Each project is also addressable as `file:<rel>`, `file:./<rel>`, `file:<abs>`, `file:~/<home-rel>` (with or without trailing `/`).
- `:hostname(<domain>)`: matches registry URL host, git remote host (named hosts like `github` -> `github.com`), remote tarball host; file/workspace never match; "a node whose spec carries no registry has no hostname to compare and will not match." Examples `:hostname(registry.npmjs.org)`, `:hostname(npm.pkg.github.com)`, `:hostname(github.com)` (/client/selectors/pseudo-classes/hostname)
- `:registry(<name>)`: matches by `registries` alias; "Only registry-type packages are matched". Examples `:registry(npm)`, `:registry(custom)`, `:registry(npm):outdated` (/client/selectors/pseudo-classes/registry)

---

## 7. npm interoperability & lockfile migration

- /npm-interoperability: "Keep your package manager. Point its registry at vlt" — `npm config set registry=<your-vlt-registry-url>`; scope: `npm config set @mycompany:registry=<your-vlt-registry-url>`; "vlt's registry speaks the npm registry API, so pnpm, Yarn, & Bun switch the same way"; "installs land in a standard `node_modules`"; install script `curl -fsSL https://install.vlt.sh | bash`; "vlt requires Node.js 22.22 or later."
- Lockfiles NOT read: "Your existing `package-lock.json` is not read or migrated — vlt performs a fresh resolution." (/client/migration/from-npm); "The `pnpm-lock.yaml` file is not migrated" (/client/migration/from-pnpm); "Your `yarn.lock` is not read." (/client/migration/from-yarn). `bun.lock`: not mentioned in client docs (UNCONFIRMED; presumably same).
- Writes: `vlt-lock.json` (project root) [CLI 1.3.6 confirmed; `lockfileVersion: 1`, records `options.registries`, nodes keyed `~npm~abbrev@2.0.0`], plus `node_modules/.vlt-lock.json` (hidden lockfile) [CLI 1.3.6].
- node_modules layout: packages stored in `node_modules/.vlt/<id>/node_modules/<name>` with top-level symlinks, e.g. `node_modules/abbrev -> .vlt/~npm~abbrev@2.0.0/node_modules/abbrev` [CLI 1.3.6]; docs: "different internal layout (under `node_modules/.vlt/`)" (/client/migration/from-pnpm). Global store under `<cache>/store`, hardlinked on Linux by default (`store-linker=auto`) (/client/commands/cache).
- `.npmrc`: NOT honored. Docs: "Configuration moves to `vlt.json` — A single JSON file replaces `.npmrc`..." (/client/migration); "Move any scoped registry config from `.npmrc` to `vlt.json`" (/client/migration/from-npm). Test: project with only `.npmrc` (`registry=`, `@x:registry=`) -> `vlt config pick registry registries scoped-registries` shows none set [CLI 1.3.6].
- Workspaces: root `package.json#workspaces` read as-is; `vlt.json` `workspaces` "wins outright"; `pnpm-workspace.yaml` must be moved (/client/migration, /client/migration/from-npm).
- npm->vlt mapping: `npm ci` -> `vlt install --expect-lockfile`; `npm audit` -> `vlt query ':malware'`; `npm overrides` -> Graph Modifiers; `npx` -> `vlx`; `NPM_TOKEN` -> `VLT_TOKEN` (/client/migration/from-npm)

---

## 8. Graph modifiers & catalogs

- Modifiers: top-level `vlt.json` `"modifiers": { "<DSS selector>": "<spec>" }`, e.g. `{"modifiers":{":root > #express":"^4.18.0","#lodash":"^4.17.21"}}`; supported subset `:root`, `:project`, `:workspace`, `#id`, `:v(^1.0.0)`, `>`; CSS-like specificity; inline `/* comments */` in keys; value may be `catalog:tools`; graph rebuilt when `modifiers` changes (/client/graph-modifiers)
- Catalogs: top-level `vlt.json` `"catalog": { "<name>": "<range>" }` (default) and `"catalogs": { "<catalogName>": { "<name>": "<range>" } }`; reference as `"catalog:"` or `"catalog:<name>"` in package.json; `vlt install typescript@catalog:`, `vlt install vitest@catalog:testing`; edits re-resolved on next `vlt install`, `--frozen-lockfile`/`vlt ci` fail until then (/client/catalogs). Docs' JSON examples are empty in the dump; top-level placement confirmed [CLI 1.3.6].
