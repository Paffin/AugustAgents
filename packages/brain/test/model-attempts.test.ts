import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FallbackProvider, LlmAttemptObserverError, LlmUsageError, OpenAiCompatibleProvider, UsageRequiredProvider, type LlmAttemptEvent, type LlmProvider, type LlmUsage } from "../src/index.ts";

// Public transport/accounting safety contracts. Actual owned sockets, NOT real-model acceptance.
const servers: Server[] = []; const directories: string[] = [];
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  directories.forEach(directory => rmSync(directory, { recursive: true, force: true }));
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const messages = [{ role: "user" as const, content: "owned transport fixture; no model qualification" }];
const receipt: LlmUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
const reply = (response: ServerResponse, text = "transport fixture") => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: receipt.inputTokens, completion_tokens: receipt.outputTokens, total_tokens: receipt.totalTokens } }));
};
async function endpoint(handle: (request: IncomingMessage, response: ServerResponse, ordinal: number) => void) {
  let hits = 0;
  const server = createServer((request, response) => handle(request, response, ++hits));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, hits: () => hits, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}
const provider = (url: string, extra: { retries?: number; name?: string } = {}) => new OpenAiCompatibleProvider({
  baseUrl: url, model: "transport-fixture", retries: 0, timeoutMs: 2000, ...extra, sleep: async () => {},
});
const finalEvents = (events: LlmAttemptEvent[]) => events.filter(event => event.type !== "started");

describe("durable LLM attempt public lifecycle", () => {
  test("started callback has fsynced its owned record before the HTTP server receives the request", async () => {
    const gate = deferred(); const started = deferred();
    const directory = mkdtempSync(join(tmpdir(), "august-attempt-contract-")); directories.push(directory);
    const path = join(directory, "attempt.json"); let persisted = false; let observedPersistence = false;
    const remote = await endpoint((_request, response) => {
      observedPersistence = persisted && JSON.parse(readFileSync(path, "utf8")).type === "started";
      reply(response);
    });
    const events: LlmAttemptEvent[] = [];
    const call = provider(remote.url).complete(messages, { requireUsage: true, onAttempt: async event => {
      events.push(event);
      if (event.type === "started") {
        started.resolve(); await gate.promise;
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(event)); await file.sync(); } finally { await file.close(); }
        persisted = true;
      }
    } });
    await started.promise;
    expect(remote.hits()).toBe(0);
    gate.resolve();
    await expect(call).resolves.toBe("transport fixture");
    expect(observedPersistence).toBe(true);
    expect(events.map(event => event.type)).toEqual(["started", "receipt"]);
    expect(events[1]!.id).toBe(events[0]!.id);
  });

  test("an HTTP receipt is retained before empty-text validation fails, without a second terminal event", async () => {
    const remote = await endpoint((_request, response) => reply(response, ""));
    const events: LlmAttemptEvent[] = []; const usage: LlmUsage[] = [];
    await expect(provider(remote.url).complete(messages, { requireUsage: true,
      onAttempt: event => { events.push(event); }, onUsage: value => { usage.push(value); },
    })).rejects.toThrow("no text");
    expect(events.map(event => event.type)).toEqual(["started", "receipt"]);
    expect(finalEvents(events)).toHaveLength(1);
    expect(events[1]).toMatchObject({ type: "receipt", id: events[0]!.id, usage: receipt });
    expect(usage).toEqual([receipt]);
  });

  test("actual connection refusal is not_sent, not unknown, with exactly one failed event", async () => {
    const remote = await endpoint((_request, response) => reply(response));
    await new Promise<void>(resolve => remote.server.close(() => resolve()));
    const events: LlmAttemptEvent[] = [];
    await expect(provider(remote.url).complete(messages, { onAttempt: event => { events.push(event); } })).rejects.toThrow();
    expect(events.map(event => event.type)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ type: "failed", id: events[0]!.id, outcome: "not_sent", reason: "unreachable" });
    expect(remote.hits()).toBe(0);
  });

  test("a real redirect never reaches a second origin and leaves the first request's billing unknown", async () => {
    const destination = await endpoint((_request, response) => reply(response));
    const redirect = await endpoint((_request, response) => {
      response.writeHead(307, { Location: `${destination.url}/chat/completions` }); response.end();
    });
    const events: LlmAttemptEvent[] = [];
    await expect(provider(redirect.url).complete(messages, { onAttempt: event => { events.push(event); } })).rejects.toThrow();
    expect(redirect.hits()).toBe(1); expect(destination.hits()).toBe(0);
    expect(events.map(event => event.type)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ id: events[0]!.id, outcome: "unknown" });
  });

  test("abort of a physically pending request is unknown exactly once and makes no retry/fallback request", async () => {
    const received = deferred(); const closed = deferred();
    const primary = await endpoint((_request, response) => { response.once("close", () => closed.resolve()); received.resolve(); });
    const backup = await endpoint((_request, response) => reply(response));
    const abort = new AbortController(); const events: LlmAttemptEvent[] = [];
    const fallback = new FallbackProvider([provider(primary.url, { retries: 3 }), provider(backup.url)]);
    const call = fallback.complete(messages, { signal: abort.signal, onAttempt: event => { events.push(event); } });
    await received.promise; abort.abort();
    await expect(call).rejects.toThrow(); await closed.promise;
    expect(primary.hits()).toBe(1); expect(backup.hits()).toBe(0);
    expect(events.map(event => event.type)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ type: "failed", id: events[0]!.id, outcome: "unknown", reason: "aborted" });
  });

  test("a failed started persistence callback is fatal before any primary or fallback HTTP call", async () => {
    const primary = await endpoint((_request, response) => reply(response));
    const backup = await endpoint((_request, response) => reply(response));
    const events: LlmAttemptEvent[] = [];
    await expect(new FallbackProvider([provider(primary.url), provider(backup.url)]).complete(messages, {
      onAttempt: event => { events.push(event); throw new Error("owned persistence failure"); },
    })).rejects.toBeInstanceOf(LlmAttemptObserverError);
    expect(events.map(event => event.type)).toEqual(["started"]);
    expect(primary.hits()).toBe(0); expect(backup.hits()).toBe(0);
  });

  test("opaque adapters correlate reported usage, while missing receipts remain unknown and fatal", async () => {
    const events: LlmAttemptEvent[] = [];
    const reporting: LlmProvider = { name: "owned opaque adapter", async complete(_messages, options) {
      await options?.onUsage?.(receipt); return "adapter transport fixture";
    } };
    await expect(new UsageRequiredProvider(reporting).complete(messages, { onAttempt: event => { events.push(event); } })).resolves.toBe("adapter transport fixture");
    expect(events.map(event => event.type)).toEqual(["started", "receipt"]);
    expect(events[1]).toMatchObject({ id: events[0]!.id, usage: receipt });
    events.length = 0;
    const missing: LlmProvider = { name: "owned receipt-less adapter", async complete() { return "unreported fixture"; } };
    await expect(new UsageRequiredProvider(missing).complete(messages, { onAttempt: event => { events.push(event); } })).rejects.toBeInstanceOf(LlmUsageError);
    expect(events.map(event => event.type)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ id: events[0]!.id, outcome: "unknown", reason: "provider_error" });
  });

  test("physical retries and fallback requests have distinct IDs, with one receipt for the successful request", async () => {
    const retry = await endpoint((_request, response, ordinal) => { if (ordinal === 1) { response.writeHead(503); response.end(); } else reply(response); });
    const events: LlmAttemptEvent[] = [];
    await provider(retry.url, { retries: 1 }).complete(messages, { requireUsage: true, onAttempt: event => { events.push(event); } });
    expect(events.map(event => event.type)).toEqual(["started", "failed", "started", "receipt"]);
    expect(events[0]!.id).not.toBe(events[2]!.id);
    expect(events[1]!.id).toBe(events[0]!.id); expect(events[3]!.id).toBe(events[2]!.id);
    const retryStarts = events.filter(event => event.type === "started");
    expect(retryStarts[0]!.requestHash).toBe(retryStarts[1]!.requestHash);
    events.length = 0;
    const failed = await endpoint((_request, response) => { response.writeHead(503); response.end(); });
    const backup = await endpoint((_request, response) => reply(response));
    await new FallbackProvider([provider(failed.url), provider(backup.url)]).complete(messages, { onAttempt: event => { events.push(event); } });
    expect(events.map(event => event.type)).toEqual(["started", "failed", "started", "receipt"]);
    expect(events[0]!.id).not.toBe(events[2]!.id);
    expect(finalEvents(events)).toHaveLength(2);
    expect(failed.hits()).toBe(1); expect(backup.hits()).toBe(1);
  });
});
