import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Host-native build. Cross-platform binaries require that platform's verified addons/libraries.
const root = resolve(import.meta.dir, "..");
const runtime = resolve(dirname(fileURLToPath(import.meta.resolve("onnxruntime-node"))), "../bin/napi-v6", process.platform, process.arch);
if (!existsSync(runtime)) throw new Error("Install the host's pinned onnxruntime-node dependencies first");
const name = readdirSync(runtime).filter(file => /^(lib)?onnxruntime(?:\.so(?:\.\d+)*|(?:\.\d+)*\.dylib|\.dll)$/.test(file)).sort((a, b) => a.length - b.length)[0];
if (!name) throw new Error("No CPU ONNX runtime library for this host");
const outfile = resolve(process.argv[2] ?? join(root, "dist/august"));
mkdirSync(dirname(outfile), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "packages/app/src/bin.ts")],
  compile: { outfile, assets: [join(runtime, name)], autoloadDotenv: false },
});
if (!result.success) { for (const message of result.logs) console.error(message); process.exit(1); }
console.log("Built host-native August with its ONNX runtime library.");
