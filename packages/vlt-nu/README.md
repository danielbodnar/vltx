# vlt-nu (prototype)

`vlt.nu` is the first Nushell 0.116 prototype of the vltx module: a `vlt` extern with subcommand completions, a pure Nushell `vltx detect`, and a `tui select --multi` feature picker for `vltx init`. It is kept here as the tested record of what worked first.

The maintained module is [`packages/vltx/vltx.nu`](../vltx/vltx.nu), shipped in the `@danielbodnar/vltx` npm package. It wraps every vltx command with typed flags and completions, returns tables for the JSON-capable commands, runs a `tui` wizard (detection, features, scope, package manager, account, dry-run plan, apply), and completes `vlt` and `vlx`. Use that one:

```nu
use packages/vltx/vltx.nu *
vltx
```

Two findings from this prototype carried over: a list flag's completer goes after the type (`--init: list<string>@"nu-complete vltx features"`), and `tui debug --keys` takes key names such as `space`, `down` and `enter`.
