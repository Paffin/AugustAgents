import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeLayaTransport, nativeLayaIdentity, validateNativeLayaBundle, verifyNativeLayaBundle, type NativeLayaBundle } from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture(): NativeLayaBundle {
  const directory = mkdtempSync(join(tmpdir(), "august-native-fixture-")); dirs.push(directory);
  const sha256 = {} as NativeLayaBundle["sha256"];
  for (const [name, file] of Object.entries({ model: "model.onnx", tokenizer: "tokenizer.json", tokenizerConfig: "tokenizer_config.json", modelConfig: "rl_agent_config.json" })) {
    const bytes = `fixture:${name}`; writeFileSync(join(directory, file), bytes);
    sha256[name as keyof typeof sha256] = createHash("sha256").update(bytes).digest("hex");
  }
  return { directory, sha256 };
}

// Safety/security invariant (REQ-FUNC-007): local assets and engine-qualified evidence are content-bound.
describe("native Laya asset boundary", () => {
  test("requires absolute paths and every hash; copies the owner input", () => {
    const bundle = fixture();
    expect(() => validateNativeLayaBundle({ ...bundle, directory: "relative" })).toThrow(/absolute/);
    for (const name of Object.keys(bundle.sha256)) {
      expect(() => validateNativeLayaBundle({ ...bundle, sha256: { ...bundle.sha256, [name]: "not-a-hash" } })).toThrow(/SHA-256/);
    }
    const saved = validateNativeLayaBundle(bundle); bundle.sha256.model = "0".repeat(64);
    expect(saved.sha256.model).not.toBe(bundle.sha256.model);
  });

  test("identity survives relocation but changes when any model input changes", () => {
    const bundle = fixture(); const identity = nativeLayaIdentity(bundle);
    expect(nativeLayaIdentity({ ...bundle, directory: "/another/owned/path" })).toBe(identity);
    for (const name of Object.keys(bundle.sha256)) {
      expect(nativeLayaIdentity({ ...bundle, sha256: { ...bundle.sha256, [name]: "0".repeat(64) } })).not.toBe(identity);
    }
  });

  test("refuses a changed weight/tokenizer/config before importing the runtime", async () => {
    for (const file of ["model.onnx", "tokenizer.json", "tokenizer_config.json", "rl_agent_config.json"]) {
      const bundle = fixture(); expect(Object.keys(verifyNativeLayaBundle(bundle))).toHaveLength(4);
      writeFileSync(join(bundle.directory, file), "replaced-owner-data");
      const transport = new NativeLayaTransport(bundle);
      await expect(transport.ready()).rejects.toThrow(/checksum mismatch/);
      await transport.close();
    }
  });

  test("closed transports cannot start another inference or load", async () => {
    const transport = new NativeLayaTransport(fixture()); await transport.close(); await transport.close();
    await expect(transport.ready()).rejects.toThrow(/closed/);
    await expect(transport.predict({ state: "private", question: { id: "q", instructions: "choose", options: [{ key: "a", description: "a" }, { key: "b", description: "b" }] } })).rejects.toThrow(/closed/);
  });
});
