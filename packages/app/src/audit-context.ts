import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AnchorLog, AuditKey, EventJournal, ExternalAuditConflict, externalAnchorHttp, publishExternalAnchors, verifyAudit, verifyExternalAudit, type ExternalAnchorTransport } from "@august/core";
import { ConfigError, type AugustConfig } from "./config.ts";
import { assertKeyDirectoryOutside, deriveKey, loadMasterKey } from "./masterkey.ts";
import { openSecretStore, resolveSecret, type SecretStore } from "./secrets.ts";

interface AuditDeps { env: Record<string, string | undefined>; home: string; secrets?: SecretStore }
export const auditKeyDir = (deps: AuditDeps): string => deps.env.AUGUST_KEY_DIR ?? join(deps.home, ".config", "august");

/** Only the configured collection receives this secret. CLI source overrides must match it exactly. */
export function auditTransport(config: AugustConfig, deps: AuditDeps, signal?: AbortSignal, source?: string): ExternalAnchorTransport {
  const external = config.auditExternal;
  if (!external) throw new ConfigError("External audit sink is not configured (auditExternal.url and tokenEnv).");
  if (source !== undefined) {
    let requested: string;
    try { requested = new URL(source).href; } catch { throw new ConfigError("Invalid external anchor source."); }
    if (requested !== new URL(external.url).href) throw new ConfigError("--anchors must match auditExternal.url; no credential was sent to another source.");
  }
  const store = deps.secrets ?? (deps.env[external.tokenEnv] ? undefined : openSecretStore(dirname(config.dataDir), {
    env: deps.env, keyDir: auditKeyDir(deps), createKey: false, protectedDirectories: [config.root, dirname(config.dataDir)],
  }));
  const token = resolveSecret(external.tokenEnv, store, deps.env);
  if (!token) throw new ConfigError(`External audit credential missing: august secret set ${external.tokenEnv}`);
  const ca = external.caFile ? readFileSync(external.caFile) : undefined;
  if (ca && ca.length > 1024 * 1024) throw new ConfigError("External audit CA file exceeds 1 MiB.");
  return externalAnchorHttp({ url: external.url, token, signal, certificateAuthority: ca });
}

/** No App, runtime owner, key provisioning, migrations, journal appends or shutdown signing. */
export function openAuditInspection(config: AugustConfig, deps: AuditDeps) {
  const keyDir = auditKeyDir(deps);
  assertKeyDirectoryOutside(keyDir, [config.root, resolve(dirname(config.dataDir))]);
  const master = loadMasterKey({ env: deps.env, keyDir, create: false });
  if (!master) throw new ConfigError("Existing audit key is unavailable; verification did not create a new key.");
  const key = new AuditKey(deriveKey(master.key, "audit-ed25519"));
  const log = new AnchorLog(join(keyDir, "audit", "anchors.jsonl"));
  const journal = new EventJournal(join(config.dataDir, "journal.db"), { readOnly: true });
  return {
    keyId: key.id, publicKey: key.publicKeyBytes().toString("base64"), anchors: () => log.list(),
    verify: () => verifyAudit(journal, log.list(), key.publicKeyBytes(), key.id),
    verifyExternal: (source?: string) => verifyExternalAudit(journal, auditTransport(config, deps, undefined, source), key.publicKeyBytes()),
    close: () => journal.close(),
  };
}

export interface AuditExternalStatus {
  state: "not-configured" | "pending" | "published" | "unavailable" | "conflict";
  anchoredThrough: number;
  localThrough: number;
  checkedAt?: number;
}

/** The existing signed log is the durable backlog. One non-blocking publisher; no new queue/database. */
export class AuditPublisher {
  private value: AuditExternalStatus;
  private current?: Promise<AuditExternalStatus>;
  private readonly abort = new AbortController();
  private readonly timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly config: AugustConfig, private readonly deps: AuditDeps, private readonly journal: EventJournal,
    private readonly log: AnchorLog, private readonly key: AuditKey, private readonly anchor: () => unknown) {
    this.value = { state: config.auditExternal ? "pending" : "not-configured", anchoredThrough: 0, localThrough: 0 };
    if (config.auditExternal) {
      this.timer = setInterval(() => { void this.publish(); }, config.auditExternal.intervalMs ?? 30_000);
      this.timer.unref();
      void this.publish();
    }
  }

  status(): AuditExternalStatus {
    return { ...this.value, localThrough: this.journal.head()?.seq ?? 0 };
  }

  publish(): Promise<AuditExternalStatus> {
    if (this.current) return this.current;
    if (this.stopped || !this.config.auditExternal) return Promise.resolve(this.status());
    this.current = (async () => {
      try {
        // Do not sign a damaged local history while publishing or recovering a lost acknowledgement.
        if (!verifyAudit(this.journal, this.log.list(), this.key.publicKeyBytes(), this.key.id).ok) throw new ExternalAuditConflict();
        const transport = auditTransport(this.config, this.deps, this.abort.signal);
        // Reconcile independent custody first: losing a local log is not permission to start a new chain.
        await publishExternalAnchors(this.journal, this.log, transport, this.key.publicKeyBytes());
        if (this.stopped) throw new Error("publisher stopped");
        this.anchor();
        const result = await publishExternalAnchors(this.journal, this.log, transport, this.key.publicKeyBytes());
        this.value = { state: "published", anchoredThrough: result.anchoredThrough, localThrough: this.journal.head()?.seq ?? 0, checkedAt: Date.now() };
      } catch (error) {
        this.value = { ...this.value, state: error instanceof ExternalAuditConflict ? "conflict" : "unavailable", checkedAt: Date.now() };
      }
      return this.status();
    })().finally(() => { this.current = undefined; });
    return this.current;
  }

  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.abort.abort(); }
}
