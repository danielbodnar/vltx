# vlt-lab tasks. `just` lists them; `just check` runs the fast gates.

set shell := ["sh", "-eu", "-c"]

default:
    @just --list

# Fast gates: renderer unit tests, cross-language conformance, shell syntax, specs
check: test-profile conformance lint specs

# Registry-profile reference renderer (bun test; `just test-profile vitest` for the alternative)
test-profile runner="bun":
    cd packages/registry-profile && {{ if runner == "vitest" { "bunx vitest run" } else { "bun test" } }}

# Nushell and POSIX sh renderers must match the TypeScript reference byte for byte
conformance:
    sh test/conformance.sh

# Syntax-check every POSIX sh script with dash
lint:
    find . -name '*.sh' -not -path '*/node_modules/*' -not -path './.tmp/*' -exec dash -n {} \;
    @echo "dash -n: ok"

# Validate both openspec changes
specs:
    openspec validate add-vlt-evaluation-lab
    openspec validate add-vltx-cli

# vltx CLI: tests, bundle, pack
test-vltx:
    cd packages/vltx && bun test

build-vltx:
    cd packages/vltx && bun run build

pack out=".tmp/pack":
    mkdir -p {{ out }}
    cd packages/vltx && npm pack --pack-destination ../../{{ out }}
    cd packages/create-vltx && npm pack --pack-destination ../../{{ out }}

# Run one example's test.sh, e.g. `just example 07-nono-sandboxing`
example name:
    sh examples/{{ name }}/test.sh

# Run every example test (slow: installs packages, starts local registries)
test-examples:
    for t in examples/*/test.sh examples/*/*/test.sh; do echo "== $t"; sh "$t"; done

# Cloudflare registry gate: unit + Workers-runtime tests and live local smoke
test-gate:
    sh examples/01-registry-backends/d-cf-registry-gate/test.sh

# Everything
test-all: check test-vltx test-examples
