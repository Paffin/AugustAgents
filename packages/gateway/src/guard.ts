import { timingSafeEqual } from "node:crypto";

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"] as const;
export const MIN_TOKEN_LENGTH = 16;

export function isLoopbackHost(host: string): boolean {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host.toLowerCase());
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

export interface BindConfig {
  hostname: string;
  port: number;
  token: string;
  /** Extra origins (browser UIs) allowed to call the gateway. */
  allowedOrigins?: readonly string[];
  /** Extra Host header values, for a reverse proxy or a tunnel. */
  allowedHosts?: readonly string[];
  /** Required to bind anything but loopback. */
  allowRemote?: boolean;
}

/** A local agent is not a public service: refuse the dangerous setups at start. */
export function assertSafeBind(config: BindConfig): void {
  if (config.token.length < MIN_TOKEN_LENGTH) {
    throw new GatewayConfigError(`token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (!isLoopbackHost(config.hostname) && !config.allowRemote) {
    throw new GatewayConfigError(
      `refusing to bind ${config.hostname}: only loopback is allowed unless allowRemote is set`,
    );
  }
}

export function tokensEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Compare digests' worth of bytes without leaking the length through an early return.
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? match[1]! : null;
}

export function allowedHostHeaders(config: BindConfig): Set<string> {
  const set = new Set<string>();
  for (const h of LOOPBACK_HOSTS) set.add(`${h}:${config.port}`);
  for (const h of config.allowedHosts ?? []) set.add(h.toLowerCase());
  return set;
}

export function allowedOriginList(config: BindConfig): Set<string> {
  const set = new Set<string>();
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) set.add(`http://${h}:${config.port}`);
  for (const o of config.allowedOrigins ?? []) set.add(o.toLowerCase());
  return set;
}
