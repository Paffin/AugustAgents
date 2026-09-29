import { describe, expect, test } from "bun:test";
import {
  LayaEngine,
  fitCalibrationTable,
  optionBucket,
  parseCalibrationTable,
  scriptOf,
  segmentId,
  temperatureFor,
  type DecisionQuestion,
  type SegmentKey,
  type SegmentedSample,
} from "../src/index.ts";

// Suite category: Product behavior (segmented calibration from verified outcomes) and Safety/security invariant (a damaged table is refused; one engine's fit never applies to another).
const key = (over: Partial<SegmentKey> = {}): SegmentKey => ({ question: "tool-choice", options: "2-4", script: "latin", engine: "laya-v1", ...over });

/** Samples whose model is over-confident (0.95 on the top option) but right only `accuracy` of the time. */
function samples(segment: SegmentKey, n: number, accuracy: number): SegmentedSample[] {
  return Array.from({ length: n }, (_, i) => ({ probs: [0.95, 0.05], correct: i / n < accuracy ? 0 : 1, segment }));
}

describe("segments", () => {
  test("option counts bucket, and the dominant script decides the language segment", () => {
    expect([2, 4, 5, 8, 9, 16].map(optionBucket)).toEqual(["2-4", "2-4", "5-8", "5-8", "9-16", "9-16"]);
    expect(scriptOf("read the file report.txt")).toBe("latin");
    expect(scriptOf("Прочитай файл отчёт.txt и summarize")).toBe("cyrillic");
    expect(scriptOf("读取文件内容然后总结 report")).toBe("cjk");
    expect(scriptOf("اقرأ الملف")).toBe("other");
    expect(scriptOf("12345 !!! ---")).toBe("latin");
    expect(scriptOf("")).toBe("latin");
  });

  test("ids are unambiguous at every level and coarser levels drop detail in a fixed order", () => {
    const k = key({ script: "cyrillic", options: "5-8" });
    expect(segmentId(k)).toBe("engine=laya-v1|q=tool-choice|opts=5-8|script=cyrillic");
    expect(segmentId(k, "question-options")).toBe("engine=laya-v1|q=tool-choice|opts=5-8");
    expect(segmentId(k, "question")).toBe("engine=laya-v1|q=tool-choice");
    expect(segmentId(k, "engine")).toBe("engine=laya-v1");
    expect(new Set([segmentId(key()), segmentId(key({ script: "cyrillic" })), segmentId(key({ engine: "laya-v2" }))]).size).toBe(3);
  });
});

describe("fitCalibrationTable", () => {
  test("each segment gets its own temperature: a language where the model is badly over-confident is softened more than one where it is nearly right", () => {
    const latin = key(); const cyr = key({ script: "cyrillic" });
    const table = fitCalibrationTable([...samples(latin, 100, 0.93), ...samples(cyr, 100, 0.5)], { engine: "laya-v1", now: () => Date.UTC(2026, 0, 1) });
    const a = table.fits[segmentId(latin)]!; const b = table.fits[segmentId(cyr)]!;
    expect(a.samples).toBe(100); expect(b.samples).toBe(100);
    expect(b.temperature).toBeGreaterThan(a.temperature);
    expect(b.eceAfter).toBeLessThan(b.eceBefore); expect(a.eceAfter).toBeLessThanOrEqual(a.eceBefore);
    expect(table.fits["engine=laya-v1|q=tool-choice|opts=2-4"]).toMatchObject({ level: "question-options", samples: 200 });
    expect(table.fits["engine=laya-v1"]!.samples).toBe(200);
    expect(table).toMatchObject({ version: 1, engine: "laya-v1", fittedAt: "2026-01-01T00:00:00.000Z", minSamples: 30 });
  });

  test("segments below the minimum are not fitted, and other engines' samples are ignored", () => {
    const table = fitCalibrationTable([...samples(key(), 29, 0.5), ...samples(key({ script: "cjk" }), 40, 0.5), ...samples(key({ engine: "other" }), 500, 0.5)], { engine: "laya-v1" });
    expect(table.fits[segmentId(key())]).toBeUndefined();
    expect(table.fits[segmentId(key({ script: "cjk" }))]).toBeDefined();
    expect(Object.keys(table.fits).every((id) => id.startsWith("engine=laya-v1"))).toBe(true);
    expect(fitCalibrationTable([], { engine: "laya-v1" }).fits).toEqual({});
    expect(fitCalibrationTable(samples(key(), 10, 0.5), { engine: "laya-v1", minSamples: 10 }).fits[segmentId(key())]).toBeDefined();
  });

  test("lookup falls back level by level and reports which level answered; unknown segments and other engines stay uncalibrated", () => {
    const table = fitCalibrationTable([...samples(key(), 40, 0.6), ...samples(key({ question: "risk" }), 40, 0.9)], { engine: "laya-v1" });
    expect(temperatureFor(table, key())).toMatchObject({ level: "exact", segment: segmentId(key()) });
    // Cyrillic was never seen: the (question, options) group answers.
    expect(temperatureFor(table, key({ script: "cyrillic" }))).toMatchObject({ level: "question-options" });
    // 9-16 options were never seen: the question level answers.
    expect(temperatureFor(table, key({ options: "9-16" }))).toMatchObject({ level: "question" });
    // A question never seen: the engine-wide fit answers.
    expect(temperatureFor(table, key({ question: "memory-write" }))).toMatchObject({ level: "engine" });
    expect(temperatureFor(table, key({ engine: "laya-v2" }))).toMatchObject({ level: "none", temperature: 1 });
    expect(temperatureFor(undefined, key())).toMatchObject({ level: "none", temperature: 1 });
  });
});

describe("parseCalibrationTable", () => {
  const good = fitCalibrationTable(samples(key(), 40, 0.6), { engine: "laya-v1" });
  test("a table that round-trips through JSON is accepted", () => {
    expect(parseCalibrationTable(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });
  test("damaged tables are refused whole", () => {
    const id = segmentId(key());
    const mutate = (f: (t: any) => void) => () => { const t = JSON.parse(JSON.stringify(good)); f(t); return parseCalibrationTable(t); };
    for (const bad of [null, "x", 5, {}, { ...good, version: 2 }, { ...good, engine: 1 }, { ...good, minSamples: 0 }, { ...good, fits: null }]) expect(() => parseCalibrationTable(bad)).toThrow(/invalid calibration table/);
    expect(mutate((t) => { t.fits[id].temperature = 0; })).toThrow(/invalid/);
    expect(mutate((t) => { t.fits[id].temperature = -1; })).toThrow(/invalid/);
    expect(mutate((t) => { t.fits[id].level = "everything"; })).toThrow(/invalid/);
    expect(mutate((t) => { t.fits[id].samples = 1.5; })).toThrow(/invalid/);
    expect(mutate((t) => { t.fits[id].eceAfter = "x"; })).toThrow(/invalid/);
  });
});

describe("LayaEngine with a calibration table", () => {
  const question: DecisionQuestion = { id: "tool-choice", instructions: "Which?", options: [{ key: "a", description: "a" }, { key: "b", description: "b" }] };
  const raw = async () => ({ probs: { a: 0.95, b: 0.05 } });

  test("the fitted temperature for the decision's own segment is applied and reported; a different language gets a different one", async () => {
    const table = fitCalibrationTable([...samples(key(), 60, 0.93), ...samples(key({ script: "cyrillic" }), 60, 0.5)], { engine: "laya-v1" });
    const engine = new LayaEngine(raw, { calibration: table, engine: "laya-v1" });
    const en = await engine.decide({ state: "read the report", tainted: false }, question);
    const ru = await engine.decide({ state: "прочитай отчёт", tainted: false }, question);
    expect(en.calibration).toMatchObject({ level: "exact", segment: segmentId(key()) });
    expect(ru.calibration).toMatchObject({ level: "exact", segment: segmentId(key({ script: "cyrillic" })) });
    expect(ru.confidence).toBeLessThan(en.confidence);
    expect(en.confidence).toBeLessThanOrEqual(0.95);
  });

  test("without a fit it falls back to the single temperature, then to none, and another engine's table is not applied", async () => {
    const plain = await new LayaEngine(raw).decide({ state: "s", tainted: false }, question);
    expect(plain.calibration).toMatchObject({ level: "none", temperature: 1 }); expect(plain.confidence).toBeCloseTo(0.95, 5);
    const global = await new LayaEngine(raw, { temperature: 2 }).decide({ state: "s", tainted: false }, question);
    expect(global.calibration).toMatchObject({ level: "global", temperature: 2 }); expect(global.confidence).toBeLessThan(0.95);
    const table = fitCalibrationTable(samples(key({ engine: "laya-v0" }), 60, 0.5), { engine: "laya-v0" });
    const other = await new LayaEngine(raw, { calibration: table, engine: "laya-v1" }).decide({ state: "s", tainted: false }, question);
    expect(other.calibration).toMatchObject({ level: "none" }); expect(other.confidence).toBeCloseTo(0.95, 5);
  });

  test("a refit can be swapped in without restarting", async () => {
    const engine = new LayaEngine(raw, { engine: "laya-v1" });
    const before = await engine.decide({ state: "s", tainted: false }, question);
    engine.setCalibration(fitCalibrationTable(samples(key(), 60, 0.5), { engine: "laya-v1" }));
    const after = await engine.decide({ state: "s", tainted: false }, question);
    expect(after.confidence).toBeLessThan(before.confidence); expect(after.calibration!.level).toBe("exact");
    engine.setCalibration(undefined);
    expect((await engine.decide({ state: "s", tainted: false }, question)).confidence).toBeCloseTo(before.confidence, 8);
  });
});
