// validate-report.ts: check JSON documents against report.schema.json.
//
//   bun validate-report.ts [--schema FILE] <report.json>...
//
// Implements the JSON Schema 2020-12 keywords the schema uses (type, const, enum, required,
// anyOf, properties, additionalProperties: false, items, oneOf, $ref to #/$defs, pattern, minimum).
// Prints one line per violation and exits 1 when any document fails.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Schema = Record<string, any>;
const args = process.argv.slice(2);
let schemaPath = join(dirname(fileURLToPath(import.meta.url)), "report.schema.json");
if (args[0] === "--schema") {
  schemaPath = args[1] ?? schemaPath;
  args.splice(0, 2);
}
if (args.length === 0) {
  process.stderr.write("usage: bun validate-report.ts [--schema FILE] <report.json>...\n");
  process.exit(2);
}
const root: Schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const typeOk = (v: unknown, t: string): boolean => {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
};

const check = (v: unknown, s: Schema, path: string): string[] => {
  if (s.$ref) {
    const ref = String(s.$ref).replace(/^#\//, "").split("/");
    return check(v, ref.reduce((o: any, k) => o[k], root), path);
  }
  const errs: string[] = [];
  if (s.type !== undefined) {
    const ts: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!ts.some((t) => typeOk(v, t))) return [`${path}: expected ${ts.join("|")}, got ${typeOf(v)}`];
  }
  if ("const" in s && JSON.stringify(v) !== JSON.stringify(s.const)) errs.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if (s.pattern && typeof v === "string" && !new RegExp(s.pattern).test(v)) errs.push(`${path}: does not match ${s.pattern}`);
  if (s.minimum !== undefined && typeof v === "number" && v < s.minimum) errs.push(`${path}: below minimum ${s.minimum}`);
  if (s.oneOf) {
    const passing = (s.oneOf as Schema[]).filter((sub) => check(v, sub, path).length === 0).length;
    if (passing !== 1) errs.push(`${path}: matches ${passing} oneOf branches, expected exactly 1`);
  }
  if (s.anyOf && !(s.anyOf as Schema[]).some((sub) => check(v, sub, path).length === 0)) errs.push(`${path}: matches none of anyOf`);
  if (typeOf(v) === "object") {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) errs.push(`${path}: missing required ${k}`);
    for (const [k, sub] of Object.entries((s.properties ?? {}) as Record<string, Schema>)) {
      if (k in o) errs.push(...check(o[k], sub, `${path}.${k}`));
    }
    if (s.additionalProperties === false) {
      for (const k of Object.keys(o)) if (!(k in (s.properties ?? {}))) errs.push(`${path}: unexpected property ${k}`);
    }
  }
  if (typeOf(v) === "array" && s.items) (v as unknown[]).forEach((x, i) => errs.push(...check(x, s.items, `${path}[${i}]`)));
  return errs;
};

let failed = false;
for (const file of args) {
  const errs = check(JSON.parse(readFileSync(file, "utf8")), root, "$");
  if (errs.length > 0) {
    failed = true;
    for (const e of errs) process.stdout.write(`${file}: ${e}\n`);
  }
}
process.exit(failed ? 1 : 0);
