// Environment scrubbing for code vltx runs but does not trust (install scripts, sandboxed commands).

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Variable names that carry credentials: VLT_TOKEN*, TYPESAFE_API_KEY, *_TOKEN, *_SECRET*, AWS_*,
 * plus *_API_KEY, *PASSWORD* and package-manager auth config (npm_config_//host/:_authToken and kin).
 */
export const SECRET_ENV =
  /^(VLT_TOKEN.*|TYPESAFE_API_KEY|.*_TOKEN|.*_SECRET.*|SECRET_.*|AWS_.*|.*_API_KEY|.*PASSWORD.*|(npm|pnpm|yarn|bun)_config_.*_auth.*)$/i;

export const isSecretName = (name: string): boolean => SECRET_ENV.test(name);

/** A copy of `env` without credential variables (undefined values dropped), and the names removed. */
export const scrubEnv = (env: Env): { env: Record<string, string>; stripped: string[] } => {
  const out: Record<string, string> = {};
  const stripped: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isSecretName(k)) stripped.push(k);
    else out[k] = v;
  }
  return { env: out, stripped: stripped.sort() };
};

/** Lines that hold a literal registry credential (not a ${VAR} reference). Values are never returned. */
const LITERAL_AUTH = /^(?!\s*[#;])[^=\n]*?(?:_authToken|_auth|_password)\s*=\s*(?!"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?\s*$)\S/m;

export const hasLiteralCredential = (text: string): boolean => LITERAL_AUTH.test(text);
