export type SessionKey = string & { readonly __brand: "SessionKey" };

const PART = /^[A-Za-z0-9_.@-]+$/;

export interface SessionParts {
  workspace: string;
  channel: string;
  user: string;
}

/**
 * Structured session keys keep one person's contexts apart across channels:
 * `workspace:channel:user`, never a bare user id.
 */
export function makeSessionKey(parts: SessionParts): SessionKey {
  for (const [name, value] of Object.entries(parts)) {
    if (!PART.test(value)) {
      throw new Error(`invalid session key part "${name}": ${JSON.stringify(value)}`);
    }
  }
  return `${parts.workspace}:${parts.channel}:${parts.user}` as SessionKey;
}

export function parseSessionKey(key: string): SessionParts {
  const pieces = key.split(":");
  if (pieces.length !== 3) throw new Error(`invalid session key: ${JSON.stringify(key)}`);
  const [workspace, channel, user] = pieces as [string, string, string];
  return { workspace, channel, user };
}
