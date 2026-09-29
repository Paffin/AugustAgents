import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { LayaTransportError, validateQuestion, type LayaPredictRequest, type LayaPrediction } from "./decision.ts";

/** Owner-selected local files. Hashes bind weights, tokenization and prompt limits together. */
export interface NativeLayaBundle {
  directory: string;
  sha256: { model: string; tokenizer: string; tokenizerConfig: string; modelConfig: string };
}

const files = { model: "model.onnx", tokenizer: "tokenizer.json", tokenizerConfig: "tokenizer_config.json", modelConfig: "rl_agent_config.json" } as const;

let embeddedRuntime: Promise<void> | undefined;
let runtimeLibrary: { close(): void } | undefined;
async function loadEmbeddedRuntime(): Promise<void> {
  if (!Bun.isStandaloneExecutable) return;
  await (embeddedRuntime ??= (async () => {
    const library = (Bun.embeddedFiles as readonly (Blob & { name: string })[]).find(file => /^(lib)?onnxruntime(?:\.so(?:\.\d+)*|(?:\.\d+)*\.dylib|\.dll)$/.test(basename(file.name)));
    if (!library) throw new LayaTransportError("native Laya runtime library not embedded; build with bun run build");
    // N-API is extracted by Bun; its linked library must also exist on the host
    // loader's filesystem. Only use assets embedded in this executable.
    const directory = mkdtempSync(join(tmpdir(), "august-onnx-runtime-"));
    const path = join(directory, basename(library.name));
    process.once("exit", () => { try { unlinkSync(path); rmdirSync(directory); } catch { /* OS may still hold a mapped DLL on Windows */ } });
    await Bun.write(path, library); chmodSync(path, 0o600);
    const { dlopen } = await import("bun:ffi");
    runtimeLibrary = dlopen(path, { OrtGetApiBase: { args: [], returns: "ptr" } });
    // Retain the handle for the process lifetime: ORT's addon uses this library.
    void runtimeLibrary;
  })());
}

export function validateNativeLayaBundle(value: unknown): NativeLayaBundle {
  const bundle = value as NativeLayaBundle | undefined;
  if (!bundle || typeof bundle.directory !== "string" || !isAbsolute(bundle.directory)) throw new LayaTransportError("native Laya needs an absolute bundle directory");
  for (const name of Object.keys(files) as Array<keyof typeof files>) {
    if (typeof bundle.sha256?.[name] !== "string" || !/^[a-f0-9]{64}$/.test(bundle.sha256[name])) throw new LayaTransportError(`native Laya needs SHA-256 for ${name}`);
  }
  return { directory: bundle.directory, sha256: { ...bundle.sha256 } };
}

export function nativeLayaIdentity(bundle: NativeLayaBundle): string {
  return `onnx-${createHash("sha256").update(Object.keys(files).map(name => bundle.sha256[name as keyof typeof files]).join(":")).digest("hex").slice(0, 48)}`;
}

export function verifyNativeLayaBundle(bundle: NativeLayaBundle): Record<keyof typeof files, Buffer> {
  validateNativeLayaBundle(bundle);
  const result = {} as Record<keyof typeof files, Buffer>;
  for (const name of Object.keys(files) as Array<keyof typeof files>) {
    let bytes: Buffer;
    try { bytes = readFileSync(join(bundle.directory, files[name])); }
    catch { throw new LayaTransportError(`native Laya cannot read ${name}`); }
    if (createHash("sha256").update(bytes).digest("hex") !== bundle.sha256[name]) throw new LayaTransportError(`native Laya ${name} checksum mismatch`);
    result[name] = bytes;
  }
  return result;
}

interface Loaded {
  ort: typeof import("onnxruntime-node");
  session: import("onnxruntime-node").InferenceSession;
  tokenizer: import("tokenizers").Tokenizer;
  cls: number; sep: number; mask: number; maskText: string;
  maxLen: number; headMaxLen: number;
}

/** Lazy in-process inference: no downloads, Python, HTTP requests or configured model presets. */
export class NativeLayaTransport {
  readonly identity: string;
  private loaded?: Promise<Loaded>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly bundle: NativeLayaBundle;

  constructor(bundle: NativeLayaBundle) {
    this.bundle = validateNativeLayaBundle(bundle);
    this.identity = nativeLayaIdentity(this.bundle);
  }

  async ready(): Promise<void> {
    if (this.closed) throw new LayaTransportError("native Laya is closed");
    await (this.loaded ??= this.load());
  }

  private async load(): Promise<Loaded> {
    const bytes = verifyNativeLayaBundle(this.bundle);
    await loadEmbeddedRuntime();
    const [ort, { Tokenizer }] = await Promise.all([import("onnxruntime-node"), import("tokenizers")]);
    let config: Record<string, unknown>, limits: { max_len?: unknown; head_max_len?: unknown };
    try { config = JSON.parse(bytes.tokenizerConfig.toString("utf8")); limits = JSON.parse(bytes.modelConfig.toString("utf8")); }
    catch { throw new LayaTransportError("native Laya bundle configuration is not readable"); }
    const maxLen = limits.max_len, headMaxLen = limits.head_max_len;
    if (typeof maxLen !== "number" || !Number.isInteger(maxLen) || maxLen < 32 || maxLen > 8192 || typeof headMaxLen !== "number" || !Number.isInteger(headMaxLen) || headMaxLen < 32 || headMaxLen >= maxLen) throw new LayaTransportError("native Laya has invalid sequence limits");
    const tokenizer = Tokenizer.fromString(bytes.tokenizer.toString("utf8"));
    tokenizer.disablePadding(); tokenizer.disableTruncation();
    const special = (name: string): { text: string; id: number } => {
      const raw = config[name]; const text = typeof raw === "string" ? raw : (raw as { content?: unknown } | null)?.content;
      if (typeof text !== "string" || !text) throw new LayaTransportError(`native Laya is missing ${name}`);
      const id = tokenizer.tokenToId(text);
      if (id === null) throw new LayaTransportError(`native Laya has no token for ${name}`);
      return { text, id };
    };
    const cls = special("cls_token"), sep = special("sep_token"), mask = special("mask_token");
    // Load the same verified bytes, never reopen the path after the hash check.
    const session = await ort.InferenceSession.create(new Uint8Array(bytes.model), { executionProviders: ["cpu"] });
    const required = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"];
    if (session.inputNames.length !== required.length || !required.every(name => session.inputNames.includes(name)) || !session.outputNames.includes("logits")) {
      await session.release(); throw new LayaTransportError("unsupported native Laya graph interface");
    }
    return { ort, session, tokenizer, cls: cls.id, sep: sep.id, mask: mask.id, maskText: mask.text, maxLen, headMaxLen };
  }

  readonly predict = (request: LayaPredictRequest): Promise<LayaPrediction> => {
    if (this.closed) return Promise.reject(new LayaTransportError("native Laya is closed"));
    const result = this.queue.then(async () => {
      try {
        validateQuestion(request.question);
        const loaded = await (this.loaded ??= this.load());
        return await this.infer(loaded, request);
      } catch (error) {
        if (error instanceof LayaTransportError) throw error;
        // Native errors can contain input text or local paths; keep them out of replies/logs.
        throw new LayaTransportError("native Laya inference unavailable");
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  };

  private async infer(l: Loaded, { state, question }: LayaPredictRequest): Promise<LayaPrediction> {
    const encode = async (text: string) => (await l.tokenizer.encode(text.replaceAll(l.maskText, " "), undefined, { addSpecialTokens: false })).getIds();
    // Upstream choice format: CLS instructions SEP MASK option... SEP state SEP.
    // Constants below are the Laya prompt protocol, not model-specific answers/routing rules.
    let rows = await Promise.all(question.options.map(async option => [l.mask, ...(await encode(` ${option.key}${option.description ? `: ${option.description}` : ""}`)).slice(0, 48)]));
    let budget = l.headMaxLen - rows.reduce((sum, row) => sum + row.length, 0);
    if (budget < 16) {
      const per = Math.max(4, Math.floor((l.headMaxLen - 16) / rows.length));
      rows = rows.map(row => row.slice(0, per)); budget = l.headMaxLen - rows.reduce((sum, row) => sum + row.length, 0);
    }
    const head = (await encode(`choice question: ${question.instructions} Read \`state\`.`)).slice(0, Math.max(8, budget));
    const ids = [l.cls, ...head, l.sep], markers: number[] = [];
    for (const row of rows) { markers.push(ids.length); ids.push(...row); }
    ids.push(l.sep);
    if (ids.length + 1 > l.maxLen) throw new LayaTransportError("native Laya question exceeds the sequence limit");
    const room = Math.max(0, l.maxLen - ids.length - 1);
    if (markers.some(marker => marker >= l.maxLen)) throw new LayaTransportError("native Laya question exceeds the sequence limit");
    ids.push(...(await encode(state)).slice(0, room), l.sep);
    const { Tensor } = l.ort;
    const feeds = {
      input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      attention_mask: new Tensor("int64", new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
      marker_pos: new Tensor("int64", BigInt64Array.from(markers, BigInt), [1, markers.length]),
      marker_mask: new Tensor("bool", new Uint8Array(markers.length).fill(1), [1, markers.length]),
      qtype: new Tensor("int64", new BigInt64Array([0n]), [1]),
    };
    let outputs: Awaited<ReturnType<Loaded["session"]["run"]>> | undefined;
    try {
      outputs = await l.session.run(feeds);
      const tensor = outputs.logits;
      if (!tensor || tensor.type !== "float32" || tensor.dims.length !== 2 || tensor.dims[0] !== 1 || tensor.dims[1] !== question.options.length) throw new LayaTransportError("native Laya returned invalid logits");
      const logits = Array.from(tensor.data as Float32Array);
      if (logits.some(value => !Number.isFinite(value))) throw new LayaTransportError("native Laya returned non-finite logits");
      const max = Math.max(...logits), weights = logits.map(value => Math.exp(value - max)), total = weights.reduce((sum, value) => sum + value, 0);
      return { probs: Object.fromEntries(question.options.map((option, i) => [option.key, weights[i]! / total])), exact: true };
    } finally {
      Object.values(feeds).forEach(tensor => tensor.dispose());
      if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose());
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    if (this.loaded) { try { await (await this.loaded).session.release(); } catch { /* a failed load has no live session */ } }
  }
}
