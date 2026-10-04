# @danielbodnar/create-vltx

Creates a new JavaScript project that already installs through vlt and your private vlt.io registry namespace. It is the `create` entry point for [`@danielbodnar/vltx`](../vltx): every argument is forwarded to `vltx new`.

## Usage

```sh
export VLT_ACCOUNT=acme          # your registry.vlt.io account slug
export VLT_TOKEN=vlt_1_...       # the account's npm mirror always needs a token

bun create @danielbodnar/vltx my-app
npm init @danielbodnar/vltx my-app
pnpm create @danielbodnar/vltx my-app
vlx @danielbodnar/create-vltx my-app
```

Each of these runs `vltx new my-app`, which:

1. creates `my-app/` (it refuses a directory that exists and is not empty),
2. writes `{}` as `vlt.json` so vlt treats `my-app/` as the project root, then runs `vlt init`,
3. names the package `@<account>/my-app`,
4. runs the `vltx init -y` migration inside it: registries and the `@<account>` scope route in `vlt.json`, `.npmrc` and `bunfig.toml` for other clients, `vlt install` with lifecycle scripts denied, the `:malware` gate, and `vlt build` with the default target. Everything is recorded in `.vltx.json`, so `vltx remove` can undo it.

## Options

All options are passed through to `vltx new`:

| Option | Meaning |
|---|---|
| `--account NAME` | vlt.io account; defaults to `$VLT_ACCOUNT` |
| `--pm vlt\|bun\|pnpm\|npm\|yarn` | installer after setup (default `vlt`) |
| `--no-token-check` | continue without `VLT_TOKEN` (installs from the npm mirror will fail) |
| `--dry-run` | print what would happen and create nothing |

## How it finds vltx

`index.js` resolves the `@danielbodnar/vltx` dependency and runs its bundled `dist/vltx.js` with the same runtime that started it (Node 22.22+ or Bun 1.4+). When the dependency cannot be resolved it falls back to a `vltx` on `PATH`.

## License

MIT
