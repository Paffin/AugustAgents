import { describe, expect, test } from "bun:test";
import { ownerDay } from "../src/budget-period.ts";

// Reliability/budget contract: deterministic owner calendar geometry, not live budget admission acceptance.
describe("owner budget day", () => {
  test("boundaries use the owner's zone, not process timezone", () => {
    const day = ownerDay("Europe/Moscow", Date.parse("2026-09-30T12:45:00Z"));
    expect(day).toEqual({key:"2026-09-30",timeZone:"Europe/Moscow",startsAt:Date.parse("2026-09-29T21:00:00Z"),endsAt:Date.parse("2026-09-30T21:00:00Z")});
    expect(ownerDay("Europe/Moscow",day.startsAt).key).toBe(day.key);
    expect(ownerDay("Europe/Moscow",day.endsAt).key).toBe("2026-10-01");
  });
  test("spring and autumn DST days have their actual duration", () => {
    const spring=ownerDay("America/New_York",Date.parse("2026-03-08T12:00:00Z"));
    const autumn=ownerDay("America/New_York",Date.parse("2026-11-01T12:00:00Z"));
    expect(spring.endsAt-spring.startsAt).toBe(23*60*60*1000);
    expect(autumn.endsAt-autumn.startsAt).toBe(25*60*60*1000);
    expect(ownerDay("America/New_York",spring.startsAt-1).key).toBe("2026-03-07");
    expect(ownerDay("America/New_York",autumn.endsAt).key).toBe("2026-11-02");
  });
  test("fractional-hour zones and a skipped civil date do not invent a reset", () => {
    const kathmandu=ownerDay("Asia/Kathmandu",Date.parse("2026-09-30T12:00:00Z"));
    expect(kathmandu.startsAt).toBe(Date.parse("2026-09-29T18:15:00Z"));
    const skipped=ownerDay("Pacific/Apia",Date.parse("2011-12-30T12:00:00Z"));
    expect(skipped.key).toBe("2011-12-31");
    expect(ownerDay("Pacific/Apia",skipped.startsAt-1).key).toBe("2011-12-29");
  });
  test("invalid timestamps/zones cannot silently use another period", () => {
    expect(()=>ownerDay("not/an-owner-zone")).toThrow();
    for(const at of [NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER])expect(()=>ownerDay("UTC",at)).toThrow();
  });
});
