import { FallbackProvider, OpenAiCompatibleProvider, type ProviderCircuits } from "@august/brain";
import { ConfigError, resolveLlmPricing, type AugustConfig, type LlmConnection, type LlmPricing } from "./config.ts";
import { resolveSecret, type SecretStore } from "./secrets.ts";
import { createHash } from "node:crypto";

function providerName(connection: LlmConnection, role: "primary" | "backup"): string {
  const url = new URL(connection.baseUrl); url.pathname = url.pathname.replace(/\/+$/, "");
  const id = createHash("sha256").update(JSON.stringify([url.href, connection.model])).digest("hex").slice(0, 32);
  return `${role}:${connection.model}@${url.host}#${id}`;
}
function backupProviderName(connection: LlmConnection): string { return providerName(connection, "backup"); }
function primaryProviderName(config: AugustConfig): string { return providerName(config.llm, "primary"); }

export function createLlm(config: AugustConfig, deps: { env: Record<string, string | undefined>; fetch?: typeof fetch; circuits?: ProviderCircuits }, secrets?: SecretStore): FallbackProvider {
  const provider = (connection: LlmConnection, name?: string) => {
    if (!connection.model.trim()) throw new ConfigError('no model selected; run "august setup"');
    const apiKey = connection.apiKeyEnv ? resolveSecret(connection.apiKeyEnv, secrets, deps.env) : undefined;
    if (connection.apiKeyEnv && !apiKey) throw new ConfigError(`no API key: run "august secret set ${connection.apiKeyEnv}" (or export ${connection.apiKeyEnv})`);
    return new OpenAiCompatibleProvider({ baseUrl: connection.baseUrl, model: connection.model, apiKey, name, fetch: deps.fetch, timeoutMs: connection.timeoutMs, retries: connection.retries });
  };
  const primary = provider(config.llm, primaryProviderName(config));
  if (!config.llm.backup) return new FallbackProvider([primary], { cooldownMs: config.llm.cooldownMs, maxCooldownMs: config.llm.maxCooldownMs, circuits: deps.circuits });
  // Every actual provider needs its own owner quote, including an explicit zero for free inference.
  resolveLlmPricing({ ...config, llm: config.llm.backup });
  return new FallbackProvider([primary, provider(config.llm.backup, backupProviderName(config.llm.backup))], { cooldownMs: config.llm.cooldownMs, maxCooldownMs: config.llm.maxCooldownMs, circuits: deps.circuits });
}

export function quoteForModelAttempt(config: AugustConfig, provider: string, injected: boolean): LlmPricing {
  if (!injected && config.llm.backup && provider === backupProviderName(config.llm.backup)) return resolveLlmPricing({ ...config, llm: config.llm.backup });
  if (!injected && provider !== primaryProviderName(config)) throw new ConfigError("model attempt has no configured provider quote");
  return resolveLlmPricing(config);
}
