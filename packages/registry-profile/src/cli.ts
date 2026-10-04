#!/usr/bin/env bun
// registry-profile: render client configuration from config/registry.profiles.json
import { parseArgs } from "node:util";
import * as z from "zod";
import { defaultProfilesPath, loadProfiles, pickProfile } from "./load.ts";
import { render } from "./render.ts";
import { ProfilesDoc, targets, type Target } from "./schema.ts";

const usage = `usage: registry-profile <command> [--file profiles.json]
  list                      profile names and descriptions (tab separated)
  render <target> [profile] one of: ${targets.join(", ")}
  validate                  check the profiles document
  schema                    print the JSON Schema for the profiles document`;

const main = (argv: string[]): number => {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { file: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(`${usage}\n`);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (command === "schema") {
    const schema = z.toJSONSchema(ProfilesDoc, { target: "draft-2020-12", io: "input" });
    process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    return 0;
  }
  const doc = loadProfiles(values.file ?? defaultProfilesPath());
  switch (command) {
    case "list":
      for (const [name, p] of Object.entries(doc.profiles)) {
        process.stdout.write(`${name}\t${p.description ?? ""}\n`);
      }
      return 0;
    case "validate":
      process.stdout.write("ok\n");
      return 0;
    case "render": {
      const [target, name] = rest;
      if (!targets.includes(target as Target)) {
        process.stderr.write(`unknown target ${target ?? "(none)"}; expected one of: ${targets.join(", ")}\n`);
        return 2;
      }
      process.stdout.write(render(pickProfile(doc, name, process.env), target as Target));
      return 0;
    }
    default:
      process.stderr.write(`${usage}\n`);
      return 2;
  }
};

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`registry-profile: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
