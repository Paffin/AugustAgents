export interface OwnerDay {
  key: string;
  timeZone: string;
  /** Inclusive UTC epoch milliseconds. */
  startsAt: number;
  /** Exclusive UTC epoch milliseconds; an owner day is not necessarily 24 hours. */
  endsAt: number;
}

/** Owner calendar boundaries from IANA/Intl, without assuming the host zone or a fixed 24-hour day. */
export function ownerDay(timeZone: string, at = Date.now()): OwnerDay {
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw new Error("invalid budget timestamp");
  const format = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const keyAt = (time: number): string => {
    const parts = format.formatToParts(new Date(time));
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  };
  const key = keyAt(at);
  // Search around the actual owner date. The wider window also accommodates civil-date-line changes.
  const horizon = 3 * 24 * 60 * 60 * 1000;
  const boundary = (lo: number, hi: number, entered: (key: string) => boolean): number => {
    if (entered(keyAt(lo)) || !entered(keyAt(hi))) throw new Error("owner day boundary cannot be established");
    while (hi - lo > 1) {
      const middle = lo + Math.floor((hi - lo) / 2);
      if (entered(keyAt(middle))) hi = middle; else lo = middle;
    }
    return hi;
  };
  return { key, timeZone: format.resolvedOptions().timeZone,
    startsAt: boundary(at - horizon, at, value => value >= key),
    endsAt: boundary(at, at + horizon, value => value > key) };
}
