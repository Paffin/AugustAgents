import { defaultConfig as template, defaultConfigPath, loadConfig, writeConfig, type AugustConfig } from "../src/config.ts";

/** Test-only quote for injected providers; production templates never invent a tariff. */
export function defaultConfig(home: string): AugustConfig {
  const config = template(home);
  return { ...config, llm: { ...config.llm, model: "test-model", pricing: {
    inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000,
    source: "test-fixture", asOf: "2026-09-29",
  } } };
}

/** Mirrors an owner entering a quote after init; preserves every other setting. */
export function configureTestPricing(home: string): void {
  const path = defaultConfigPath(home), config = loadConfig(path);
  writeConfig(path, { ...config, llm: { ...config.llm, model: config.llm.model || "test-model", pricing: defaultConfig(home).llm.pricing } });
}
