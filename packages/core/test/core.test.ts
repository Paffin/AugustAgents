import { describe, expect, test } from "bun:test";
import { LaneQueue, QueueOverflowError, EventJournal, makeSessionKey, parseSessionKey } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LaneQueue", () => {
  test("runs tasks of one lane strictly in order", async () => {
    const q = new LaneQueue();
    const log: string[] = [];
    const a = q.enqueue("s", async () => {
      await sleep(20);
      log.push("a");
    });
    const b = q.enqueue("s", async () => {
      log.push("b");
    });
    await Promise.all([a, b]);
    expect(log).toEqual(["a", "b"]);
  });

  test("different lanes run in parallel", async () => {
    const q = new LaneQueue();
    const log: string[] = [];
    const slow = q.enqueue("one", async () => {
      await sleep(30);
      log.push("slow");
    });
    const fast = q.enqueue("two", async () => {
      log.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(["fast", "slow"]);
  });

  test("a failing task does not block the lane", async () => {
    const q = new LaneQueue();
    const bad = q.enqueue("s", async () => {
      throw new Error("boom");
    });
    const good = q.enqueue("s", async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    expect(await good).toBe("ok");
  });

  test("rejects when a lane overflows", async () => {
    const q = new LaneQueue({ maxPending: 1 });
    const first = q.enqueue("s", () => sleep(20));
    const second = q.enqueue("s", () => sleep(1));
    await expect(q.enqueue("s", () => undefined)).rejects.toBeInstanceOf(QueueOverflowError);
    await Promise.all([first, second]);
  });
});

describe("session keys", () => {
  test("round trip", () => {
    const key = makeSessionKey({ workspace: "home", channel: "telegram", user: "42" });
    expect(key).toBe("home:telegram:42");
    expect(parseSessionKey(key)).toEqual({ workspace: "home", channel: "telegram", user: "42" });
  });

  test("rejects separators inside parts", () => {
    expect(() => makeSessionKey({ workspace: "a:b", channel: "c", user: "d" })).toThrow();
  });
});

describe("EventJournal", () => {
  test("chains hashes and verifies", () => {
    const j = new EventJournal();
    j.append({ kind: "a", session: "s", data: { n: 1 } }, 1);
    j.append({ kind: "b", session: "s", data: { n: 2 } }, 2);
    expect(j.list("s")).toHaveLength(2);
    expect(j.verify()).toBeNull();
  });

  test("detects tampering", () => {
    const j = new EventJournal();
    j.append({ kind: "a", session: "s", data: { amount: 1 } }, 1);
    j.append({ kind: "b", session: "s", data: { amount: 2 } }, 2);
    j.rawDb.run("UPDATE journal SET data = '{\"amount\":999}' WHERE seq = 1");
    expect(j.verify()).toBe(1);
  });

  test("detects deleted entries", () => {
    const j = new EventJournal();
    j.append({ kind: "a", session: "s", data: 1 }, 1);
    j.append({ kind: "b", session: "s", data: 2 }, 2);
    j.append({ kind: "c", session: "s", data: 3 }, 3);
    j.rawDb.run("DELETE FROM journal WHERE seq = 2");
    expect(j.verify()).toBe(3);
  });
});
