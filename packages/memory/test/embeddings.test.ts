import { afterAll, describe, expect, test } from "bun:test";
import { LocalEmbeddingClient, LocalEmbeddingError, type LocalEmbeddingOptions } from "../src/embeddings.ts";

// Regression fixtures test transport and validation only; they are not semantic retrieval acceptance.
const MODEL = "regression-embedding";
const IDENTITY = "regression-weights-and-preprocessing";
const vector = [0.25, -0.5, 0.75];
const reply = (embedding: unknown = vector, model = MODEL) => ({ model, data: [{ index: 0, embedding }] });
const client = (fetchFn: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>, extra: Partial<LocalEmbeddingOptions> = {}) => new LocalEmbeddingClient({
  baseUrl: "http://127.0.0.1:12345/v1", model: MODEL, identity: IDENTITY,
  fetch: (async (url, init) => fetchFn(url, init)) as typeof fetch, ...extra,
});
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => { for (const server of servers) server.stop(true); });

describe("LocalEmbeddingClient", () => {
  test("preserves exact model, identity and private text without prefixes, and requests float vectors", async () => {
    const text = "  Напомни, где лежит мой паспорт.  ";
    let calls = 0;
    const c = client((url, init) => {
      calls++;
      expect(String(url)).toBe("http://127.0.0.1:12345/v1/embeddings");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({ input: text, model: MODEL, encoding_format: "float" });
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(reply());
    });
    expect(c.identity).toBe(IDENTITY);
    expect(await c.embed(text)).toEqual(vector);
    expect(calls).toBe(1);
  });

  test("accepts only numeric loopback or localhost, never credentials or ambiguous addresses", () => {
    for (const baseUrl of ["http://127.1.2.3/v1", "https://127.0.0.1/v1", "http://[::1]/v1", "http://localhost/v1"]) {
      expect(() => client(() => Response.json(reply()), { baseUrl })).not.toThrow();
    }
    for (const baseUrl of ["https://api.example.com/v1", "http://10.0.0.1/v1", "http://0.0.0.0/v1", "http://localhost.example.com/v1", "http://[::ffff:127.0.0.1]/v1", "file:///embeddings", "http://key:private@127.0.0.1/v1", "http://127.0.0.1/v1?key=private", "http://127.0.0.1/v1#private", "http://127.0.0.1:0/v1", "not an address"]) {
      expect(() => client(() => Response.json(reply()), { baseUrl })).toThrow(LocalEmbeddingError);
    }
  });

  test("normalizes localhost to numeric loopback so DNS cannot redirect private text", async () => {
    const c = client((url) => {
      expect(String(url)).toBe("http://127.0.0.1:12345/v1/embeddings");
      return Response.json(reply());
    }, { baseUrl: "http://localhost:12345/v1///" });
    expect(await c.embed("private query")).toEqual(vector);
  });

  test("requires explicit model, identity and bounded positive timeout", () => {
    for (const extra of [{ model: "" }, { model: " alias " }, { identity: "" }, { identity: " fingerprint " }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 0.5 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 }, { apiKey: "" }, { apiKey: "private\ncredential" }]) {
      expect(() => client(() => Response.json(reply()), extra)).toThrow(LocalEmbeddingError);
    }
  });

  test("rejects empty or excessive UTF-8 input before any request", async () => {
    let calls = 0;
    const c = client(() => { calls++; return Response.json(reply()); });
    for (const input of ["", " \n ", "x".repeat(256 * 1024 + 1), "я".repeat(128 * 1024 + 1)]) {
      await expect(c.embed(input)).rejects.toThrow(/input/);
    }
    expect(calls).toBe(0);
  });

  test("checks actual response model, batch cardinality and index", async () => {
    for (const body of [reply(vector, "other-model"), { model: MODEL, data: [] }, { model: MODEL, data: [reply().data[0], reply().data[0]] }, { model: MODEL, data: [{ index: 1, embedding: vector }] }, { model: MODEL, data: [null] }, { model: MODEL, data: [vector] }]) {
      await expect(client(() => Response.json(body)).embed("query")).rejects.toThrow(LocalEmbeddingError);
    }
  });

  test("rejects empty, zero, nested, nonnumeric and nonfinite vectors", async () => {
    for (const embedding of [[], [0, 0, -0], [1, null], [1, "2"], [[1], [2]], [NaN], [Infinity], [-Infinity]]) {
      await expect(client(() => Response.json(reply(embedding))).embed("query")).rejects.toThrow(/finite nonzero/);
    }
    const overflow = `{"model":"${MODEL}","data":[{"index":0,"embedding":[1e400]}]}`;
    await expect(client(() => new Response(overflow)).embed("query")).rejects.toThrow(/finite nonzero/);
  });

  test("dimensions are stable per client; invalid responses do not poison the initial dimension", async () => {
    const answers = [reply([0, 0]), reply(vector), reply([1, 2]), reply(vector)];
    const c = client(() => Response.json(answers.shift()));
    await expect(c.embed("first")).rejects.toThrow(/finite nonzero/);
    expect(await c.embed("second")).toEqual(vector);
    await expect(c.embed("third")).rejects.toThrow(/dimensions changed/);
    expect(await c.embed("fourth")).toEqual(vector);
  });

  test("status, provider JSON and transport errors do not disclose body, input or credential", async () => {
    const privateText = "private-regression-content";
    const key = "private-regression-credential";
    const responses = [() => new Response(privateText + key, { status: 401 }), () => new Response(privateText + key), () => Response.json({ model: privateText + key, data: [] }), () => { throw new Error(privateText + key); }];
    for (const fetchFn of responses) {
      try { await client(fetchFn, { apiKey: key }).embed(privateText); throw new Error("unexpected success"); }
      catch (error) {
        expect(error).toBeInstanceOf(LocalEmbeddingError);
        expect(String(error)).not.toContain(privateText);
        expect(String(error)).not.toContain(key);
      }
    }
    await expect(client(() => new Response(null, { status: 204 })).embed("query")).rejects.toThrow(/HTTP 204/);
  });

  test("bounds declared and streamed reply bytes and cancels the oversized stream", async () => {
    let cancelled = 0;
    const declared = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-length": String(1024 * 1024 + 1) } });
    await expect(client(() => declared).embed("query")).rejects.toThrow(/byte limit/);
    const streamed = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled++; },
    }));
    await expect(client(() => streamed).embed("query")).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(2);
  });

  test("timeout bounds fetching even when an injected transport ignores cancellation", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const c = client((_, init) => { seenSignal = init?.signal; return new Promise<Response>(() => {}); }, { timeoutMs: 15 });
    await expect(c.embed("query")).rejects.toThrow(/timed out/);
    expect(seenSignal?.aborted).toBe(true);
  });

  test("timeout also bounds stalled response bodies and cancels their reader", async () => {
    let cancelled = false;
    const c = client(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })), { timeoutMs: 15 });
    await expect(c.embed("query")).rejects.toThrow(/timed out/);
    expect(cancelled).toBe(true);
  });

  test("pre-abort never calls the transport and mid-flight abort redacts arbitrary reasons", async () => {
    const controller = new AbortController();
    let calls = 0;
    const c = client(() => { calls++; return new Promise<Response>(() => {}); });
    controller.abort(new Error("private reason"));
    await expect(c.embed("query", { signal: controller.signal })).rejects.toThrow(/^embedding request was aborted$/);
    expect(calls).toBe(0);
    const during = new AbortController();
    const pending = c.embed("query", { signal: during.signal });
    during.abort(new Error("private reason"));
    await expect(pending).rejects.toThrow(/^embedding request was aborted$/);
    expect(calls).toBe(1);
  });

  test("real loopback transport sends the configured credential only to its endpoint", async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests++;
      expect(new URL(request.url).pathname).toBe("/v1/embeddings");
      expect(request.headers.get("authorization")).toBe("Bearer regression-local-key");
      expect(await request.json()).toEqual({ model: MODEL, input: "query", encoding_format: "float" });
      return Response.json(reply());
    } });
    servers.push(server);
    const c = new LocalEmbeddingClient({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: MODEL, identity: IDENTITY, apiKey: "regression-local-key" });
    expect(await c.embed("query")).toEqual(vector);
    expect(requests).toBe(1);
  });

  test("real HTTP redirect never reaches the second listener", async () => {
    let targetRequests = 0;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { targetRequests++; return Response.json(reply()); } });
    const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(`http://127.0.0.1:${target.port}/v1/embeddings`, 307); } });
    servers.push(target, redirect);
    const c = new LocalEmbeddingClient({ baseUrl: `http://127.0.0.1:${redirect.port}/v1`, model: MODEL, identity: IDENTITY });
    await expect(c.embed("query")).rejects.toThrow(LocalEmbeddingError);
    expect(targetRequests).toBe(0);
  });

  test("real Bun child ignores global proxy and verbose-fetch settings for private embedding requests", async () => {
    let proxyRequests = 0;
    let directRequests = 0;
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { proxyRequests++; return new Response("must not proxy", { status: 502 }); } });
    const direct = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { directRequests++; return Response.json(reply()); } });
    servers.push(proxy, direct);
    const options = { baseUrl: `http://127.0.0.1:${direct.port}/v1`, model: MODEL, identity: IDENTITY, apiKey: "regression-private-key", timeoutMs: 2000 };
    const source = `import { LocalEmbeddingClient } from ${JSON.stringify(new URL("../src/embeddings.ts", import.meta.url).href)};\nconst client = new LocalEmbeddingClient(${JSON.stringify(options)});\nawait client.embed("regression-private-text");\nconsole.log("ok");`;
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
      env: { PATH: process.env.PATH ?? "", HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "", BUN_CONFIG_VERBOSE_FETCH: "curl" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout.trim()).toBe("ok");
    expect(stderr).toBe("");
    expect(directRequests).toBe(1);
    expect(proxyRequests).toBe(0);
  });
});
