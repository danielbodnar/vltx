# report.jq: render a smoke result JSON (smoke.{sh,nu,ts}) as a markdown table. jq -r -f report.jq FILE
def yn: if . == true then "yes" elif . == false then "no" else "n/a" end;
def ms: if . == null then "n/a" else "\(.) ms" end;
def phase: if . == null then "not run" else "exit \(.exit), \(.ms | ms)" end;
"### Profile `\(.profile)` (\(.registry))",
"",
"Run \(.date) by smoke.\(.entrypoint). Fixture: \(.fixture | to_entries | map("`\(.key)@\(.value)`") | join(", ")).",
"",
"| Client | Version | Cold install | Warm install | Lockfile written | Lifecycle scripts ran | esbuild bin | Tarball hosts (source) | Installed |",
"|---|---|---|---|---|---|---|---|---|",
(.clients[] |
  "| \(.client) | \(.version) | \(.cold | phase) | \(.warm | phase) | \(if .lockfile_written then "yes (`\(.lockfile)`)" else "no" end) | \(.scripts_ran | yn)\(if (.script_events | length) > 0 then " (\(.script_events | join(", ")))" else "" end) | \(.esbuild_bin) | \(if (.tarball_hosts | length) > 0 then (.tarball_hosts | join(", ")) else "none" end) (\(.host_source)) | \(if .installed_ok then "all \(.installed | length)" else "incomplete" end) |"),
"",
(.clients[] | select(.error != "") | "- \(.client): `\(.error)`"),
(if (.notes | length) > 0 then "", (.notes[] | "- Note: \(.)") else empty end)
