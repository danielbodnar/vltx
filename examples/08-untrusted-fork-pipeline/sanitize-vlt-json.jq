# sanitize-vlt-json.jq: neutralize a vlt.json that arrived with an untrusted repository.
# Shared by fork-install.sh, .nu and .ts (all three run `jq -c -f sanitize-vlt-json.jq`).
#
# Input: the repository's vlt.json (already parsed by jq). Output:
#   {sanitized, keptKeys, droppedTopLevel, droppedConfigKeys, dangerousKeys, registryHosts}
#
# Policy: everything under "config" is dropped (registries come from the vlt-lab registry
# profile env, lifecycle scripts are controlled by the pipeline), and only the top-level keys
# that describe the project graph are kept. Key paths are recorded, values never are, except
# the host part of registry URLs (userinfo and path removed).

def keep_top: ["workspaces", "catalog", "catalogs", "modifiers"];

# config roots that change what runs, where packages come from, or where files are written
def dangerous_roots: [
  "allow-scripts", "command", "registry", "registries", "scoped-registries", "jsr-registries",
  "default-registry-alias", "git-hosts", "git-host-archives", "cache", "script-shell",
  "store-linker", "identity", "node-version", "os", "arch", "libc", "fallback-command",
  "dashboard-root", "editor", "save-config"
];
def registry_roots: ["registry", "registries", "scoped-registries", "jsr-registries", "git-hosts", "git-host-archives"];

def hostof: (capture("^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/]*@)?(?<h>[^/:?#]+)") | .h) // null;

if type != "object" then
  {sanitized: {}, keptKeys: [], droppedTopLevel: ["(not an object)"], droppedConfigKeys: [], dangerousKeys: [], registryHosts: []}
else
  . as $doc
  | ($doc.config) as $c
  | (if $c == null then []
     elif ($c | type) != "object" then ["config"]
     else [ $c | paths as $p
            | select(($p | all(type == "string"))
                     and (($c | getpath($p)) as $v | (($v | type) != "object") or ($v == {})))
            | $p | join(".") ] | unique
     end) as $leaves
  | (if $c != null and ($c | type) == "object" then
       [ $c | paths(type == "string") as $p
         | select(($p | all(type == "string")) and ($p[0] | IN(registry_roots[])))
         | {key: ($p | join(".")), host: ($c | getpath($p) | hostof)} ] | unique_by(.key)
     else [] end) as $hosts
  | {
      sanitized: ($doc | with_entries(select(.key | IN(keep_top[])))),
      keptKeys: ([$doc | keys[] | select(IN(keep_top[]))]),
      droppedTopLevel: ([$doc | keys[] | select((IN(keep_top[]) | not) and . != "config")]),
      droppedConfigKeys: $leaves,
      dangerousKeys: ([$leaves[] | select((split(".")[0]) | IN(dangerous_roots[]))] + (if $leaves == ["config"] then ["config"] else [] end) | unique),
      registryHosts: $hosts
    }
end
