#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { main } from "./cli.ts";

/**
 * Lines are queued as they arrive, so piped input ("printf '1\n' | august setup")
 * works as well as typing: nothing is lost between two questions, and the end
 * of input answers null instead of hanging.
 */
const rl = createInterface({ input: process.stdin });
const lines: string[] = [];
const waiters: Array<(line: string | null) => void> = [];
let closed = false;
rl.on("line", (line) => {
  const w = waiters.shift();
  if (w) w(line);
  else lines.push(line);
});
rl.on("close", () => {
  closed = true;
  for (const w of waiters.splice(0)) w(null);
});

function ask(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  if (lines.length) return Promise.resolve(lines.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

const result = await main(process.argv.slice(2), {
  print: (line) => console.log(line),
  ask,
  env: process.env,
  home: homedir(),
});

// A running gateway keeps the process alive; everything else exits here.
if (!result.gateway) {
  rl.close();
  process.exit(result.code);
}
const shutdown = () => {
  result.stop?.();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
