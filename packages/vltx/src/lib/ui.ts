// Zero-dependency terminal prompts: select, multiselect, confirm, text.
// Non-interactive sessions get a clear error asking for the equivalent flag.
import { emitKeypressEvents } from "node:readline";

const tty = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const color = (code: number) => (s: string): string => (process.env.NO_COLOR || !tty() ? s : `\x1b[${code}m${s}\x1b[0m`);
export const dim = color(2);
export const bold = color(1);
export const cyan = color(36);
export const green = color(32);
export const yellow = color(33);
export const red = color(31);

export class NotInteractive extends Error {
  constructor(what: string, flag: string) {
    super(`${what}: no terminal to ask on; pass ${flag} (or -y for defaults)`);
  }
}

export const isInteractive = tty;

export type Choice<T> = { value: T; label: string; hint?: string };

const write = (s: string): void => void process.stdout.write(s);

/** Generic list prompt; `multi` toggles with space. Returns indexes. */
const listPrompt = <T>(
  message: string,
  choices: readonly Choice<T>[],
  multi: boolean,
  initial: readonly number[],
): Promise<number[]> =>
  new Promise((resolve, reject) => {
    let cursor = initial[0] ?? 0;
    const picked = new Set(multi ? initial : []);
    let drawn = 0;
    const draw = (): void => {
      if (drawn > 0) write(`\x1b[${drawn}A\x1b[0J`);
      const lines = [
        `${cyan("◆")}  ${bold(message)}${multi ? dim("  (space toggles, enter confirms)") : ""}`,
        ...choices.map((c, i) => {
          const mark = multi ? (picked.has(i) ? green("◼") : "◻") : i === cursor ? green("●") : "○";
          const label = i === cursor ? bold(c.label) : c.label;
          return `${dim("│")}  ${mark} ${label}${c.hint ? dim(`  ${c.hint}`) : ""}`;
        }),
      ];
      write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    };
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = (err?: Error): void => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (err) reject(err);
      else resolve(multi ? [...picked].sort((a, b) => a - b) : [cursor]);
    };
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") return done(new Error("cancelled"));
      if (key.name === "up" || key.name === "k") cursor = (cursor - 1 + choices.length) % choices.length;
      else if (key.name === "down" || key.name === "j") cursor = (cursor + 1) % choices.length;
      else if (key.name === "space" && multi) picked.has(cursor) ? picked.delete(cursor) : picked.add(cursor);
      else if (key.name === "return") return done();
      else if (key.name === "escape") return done(new Error("cancelled"));
      draw();
    };
    process.stdin.on("keypress", onKey);
    draw();
  });

export const select = async <T>(message: string, choices: readonly Choice<T>[], flag: string, initial = 0): Promise<T> => {
  if (!tty()) throw new NotInteractive(message, flag);
  const [i] = await listPrompt(message, choices, false, [initial]);
  return (choices[i ?? 0] as Choice<T>).value;
};

export const multiselect = async <T>(
  message: string,
  choices: readonly Choice<T>[],
  flag: string,
  initial: readonly number[] = [],
): Promise<T[]> => {
  if (!tty()) throw new NotInteractive(message, flag);
  const idx = await listPrompt(message, choices, true, initial);
  return idx.map((i) => (choices[i] as Choice<T>).value);
};

export const confirm = async (message: string, flag: string, initial = true): Promise<boolean> =>
  select(message, [{ value: true, label: "Yes" }, { value: false, label: "No" }], flag, initial ? 0 : 1);

export const text = async (message: string, flag: string, initial = ""): Promise<string> => {
  if (!tty()) throw new NotInteractive(message, flag);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${cyan("◆")}  ${bold(message)}${initial ? dim(` (${initial})`) : ""} `);
  rl.close();
  return answer.trim() === "" ? initial : answer.trim();
};

/** A boxed summary block in the wizard's visual language. */
export const note = (title: string, lines: readonly string[]): string =>
  [`${cyan("◇")}  ${bold(title)}`, ...lines.map((l) => `${dim("│")}  ${l}`)].join("\n");
