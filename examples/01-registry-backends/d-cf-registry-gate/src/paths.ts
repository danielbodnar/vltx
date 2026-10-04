// Package name validation and request path parsing. Everything a client sends in the path is checked
// here before it reaches an upstream URL, so no traversal, extra encoding or odd character survives.

import { isValidVersion } from "./semver";

export const MAX_NAME_LENGTH = 214;

// npm's rules (validate-npm-package-name) for names that can be read: URL-safe characters, no leading
// dot or underscore, at most 214 characters. Upper case is accepted because legacy packages such as
// JSONStream still carry it; npm only refuses it for new publishes.
const PART = /^[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const SCOPE = /^[a-z0-9~-][a-z0-9._~-]*$/;
const BLOCKED_NAMES = new Set(["node_modules", "favicon.ico"]);

export const isValidName = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (name.startsWith("@")) {
    const parts = name.slice(1).split("/");
    return parts.length === 2 && SCOPE.test(parts[0]!) && PART.test(parts[1]!);
  }
  return PART.test(name) && !BLOCKED_NAMES.has(name.toLowerCase());
};

/** The part of a package name that tarball files start with: `name` for `@scope/name`. */
export const baseName = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

export type Route =
  | { kind: "packument"; name: string }
  | { kind: "tarball"; name: string; version: string; file: string }
  | { kind: "error"; status: 400 | 404; message: string };

const bad = (message: string): Route => ({ kind: "error", status: 400, message });
const notFound = (message: string): Route => ({ kind: "error", status: 404, message });

// Only the escapes clients really send in registry paths: %2f/%2F (the scope separator) and %40 ("@").
const ALLOWED_ESCAPE = /%(?:2[fF]|40)/g;

const decodeSegment = (raw: string): string | undefined => {
  if (raw.replace(ALLOWED_ESCAPE, "").includes("%")) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
};

/**
 * Parse a raw (still percent-encoded) URL pathname into a registry route.
 *
 *   /<name>                         packument
 *   /@scope%2fname, /@scope/name    packument (scoped, encoded or not; %40 accepted for "@")
 *   /<name>/-/<name>-<ver>.tgz      tarball
 *   /@scope/name/-/name-<ver>.tgz   tarball (scoped; the encoded form is accepted too)
 */
export const parseRegistryPath = (pathname: string): Route => {
  if (!pathname.startsWith("/") || pathname.includes("\\")) return bad("malformed path");
  const raw = pathname.slice(1).split("/");
  if (raw.some((s) => s.length === 0)) return bad("empty path segment");
  const segs: string[] = [];
  for (const r of raw) {
    const d = decodeSegment(r);
    if (d === undefined) return bad("unsupported percent-encoding in path");
    segs.push(d);
  }

  let name: string;
  let rest: string[];
  if (segs[0]!.startsWith("@") && segs[0]!.includes("/")) {
    name = segs[0]!;
    rest = segs.slice(1);
  } else if (segs[0]!.startsWith("@")) {
    if (segs.length < 2) return bad("invalid package name");
    name = `${segs[0]}/${segs[1]}`;
    rest = segs.slice(2);
  } else {
    if (segs[0]!.includes("/")) return bad("invalid package name");
    name = segs[0]!;
    rest = segs.slice(1);
  }
  if (!isValidName(name)) return bad("invalid package name");

  if (rest.length === 0) return { kind: "packument", name };
  if (rest.length === 2 && rest[0] === "-") {
    const file = rest[1]!;
    const prefix = `${baseName(name)}-`;
    if (!file.startsWith(prefix) || !file.endsWith(".tgz") || file.includes("/"))
      return bad("tarball file must be <name>-<version>.tgz");
    const version = file.slice(prefix.length, -".tgz".length);
    if (!isValidVersion(version)) return bad("invalid version");
    return { kind: "tarball", name, version, file };
  }
  return notFound("not found: the gate serves packuments and tarballs only");
};

/** Path of a package document on an npm registry: scoped names keep "@" and encode the slash. */
export const packumentPath = (name: string): string => name.replace("/", "%2f");

/** npm's tarball path: `<name>/-/<basename>-<version>.tgz`, scoped names unencoded. */
export const tarballPath = (name: string, version: string): string =>
  `${name}/-/${baseName(name)}-${version}.tgz`;
