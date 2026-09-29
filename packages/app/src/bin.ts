#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { main } from "./cli.ts";

const rl = createInterface({ input: process.stdin, output: process.stdout });
// A question pending when stdin ends never resolves by itself, so race it with the close event.
const closed = new Promise<null>((resolve) => rl.on("close", () => resolve(null)));

const result = await main(process.argv.slice(2), {
  print: (line) => console.log(line),
  ask: (prompt) => Promise.race([rl.question(prompt).catch(() => null), closed]),
  env: process.env,
  home: homedir(),
});

// A running gateway keeps the process alive; everything else exits here.
if (!result.gateway) {
  rl.close();
  process.exit(result.code);
}
