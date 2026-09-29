import { SecretError, resolveSecret, scopedSecretName, type SecretStore } from "./secrets.ts";

export type TrustLevel = "community" | "known" | "self-made";

/** How far a capability's network reach is limited. `open` is the only value that lets a secret leave unchecked. */
export type EgressMode = "none" | "allowlist" | "open";

export interface DeliveryContext {
  capability: string;
  /** Who vouched for the capability. Only the owner can set anything but `community`. */
  trust: TrustLevel;
  /** Its artifact was fetched by August, matched the pinned identity, and is what runs. */
  artifactVerified: boolean;
  /** It runs inside a working sandbox. */
  sandboxed: boolean;
  egress: EgressMode;
}

export class SecretDeliveryError extends Error {
  constructor(readonly capability: string, readonly reasons: string[]) {
    super(`"${capability}" cannot receive secrets: ${reasons.join("; ")}`);
    this.name = "SecretDeliveryError";
  }
}

/**
 * The only way a capability gets a secret. Secrets are kept per capability (`<id>.<NAME>`), so a
 * name a registry entry asks for can never reach the owner's own keys (the model key, the bot token,
 * anything exported in the shell). A community capability also has to be verifiable, sandboxed and
 * unable to send data to arbitrary hosts before it receives anything; a capability the owner
 * configured by hand (trust `known` or `self-made`) keeps the owner's own decision, including the
 * global secrets it names.
 */
export class SecretBroker {
  constructor(private readonly store: SecretStore | undefined, private readonly env: Record<string, string | undefined>) {}

  /** What stops this capability from receiving secrets right now. Empty means delivery is allowed. */
  blockers(ctx: DeliveryContext): string[] {
    if (ctx.trust !== "community") return [];
    const reasons: string[] = [];
    if (!ctx.artifactVerified) reasons.push("its artifact is not verified");
    if (!ctx.sandboxed) reasons.push("it does not run in a sandbox");
    if (ctx.egress === "open") reasons.push("it can reach any host");
    return reasons;
  }

  private lookup(ctx: DeliveryContext, name: string): string | undefined {
    const scoped = this.store?.get(scopedSecretName(ctx.capability, name));
    if (scoped !== undefined || ctx.trust === "community") return scoped;
    return resolveSecret(name, this.store, this.env);
  }

  /** Names not set for this capability, in the form the owner has to store them under. */
  missing(ctx: DeliveryContext, names: readonly string[]): string[] {
    return names.filter((name) => this.lookup(ctx, name) === undefined);
  }

  /** Values for `names`, or a SecretDeliveryError. A name that is not set is an error too, never an empty value. */
  deliver(ctx: DeliveryContext, names: readonly string[]): Record<string, string> {
    if (names.length === 0) return {};
    const reasons = this.blockers(ctx);
    if (reasons.length) throw new SecretDeliveryError(ctx.capability, reasons);
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = this.lookup(ctx, name);
      if (value === undefined) throw new SecretError(`${name} is not set for "${ctx.capability}" (august secret set --for ${ctx.capability} ${name})`);
      out[name] = value;
    }
    return out;
  }

  /** Store a secret in the capability's own namespace. */
  set(capability: string, name: string, value: string): void {
    if (!this.store) throw new SecretError("no secret store");
    this.store.set(scopedSecretName(capability, name), value);
  }

  /** Every value this broker could hand out for the capability, for redacting them from logs and checkpoints. */
  redactionValues(ctx: DeliveryContext, names: readonly string[]): string[] {
    return names.map((name) => this.lookup(ctx, name)).filter((v): v is string => v !== undefined && v.length > 0);
  }
}
