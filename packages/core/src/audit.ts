import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventJournal, JournalEntry } from "./journal.ts";

/** PKCS#8 prefix of an Ed25519 private key: the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class AuditKey {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  /** Public name of the key: which key signed an anchor. */
  readonly id: string;

  /** The seed is derived from the owner's recoverable master key, so recovering that key recovers the ability to sign. */
  constructor(seed: Buffer) {
    if (seed.length !== 32) throw new Error("an audit key seed is 32 bytes");
    this.privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
    this.publicKey = createPublicKey(this.privateKey);
    this.id = createHash("sha256").update(this.publicKeyBytes()).digest("hex").slice(0, 16);
  }

  publicKeyBytes(): Buffer {
    return this.publicKey.export({ format: "der", type: "spki" });
  }

  sign(message: string): string {
    return sign(null, Buffer.from(message), this.privateKey).toString("base64");
  }
}

/** Checks a signature with the public key alone, so anyone holding an exported anchor can verify it. */
export function verifyAnchorSignature(publicKeyDer: Buffer, message: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(message), createPublicKey({ key: publicKeyDer, format: "der", type: "spki" }), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * A signed statement, kept outside the journal, that the journal looked a certain way at a certain point: entry
 * `seq` had hash `hash`. Rewriting history breaks the journal's own chain and can be repaired by recomputing it,
 * but cannot be made to match an anchor signed before the rewrite without the signing key.
 */
export interface AuditAnchor {
  n: number;
  seq: number;
  hash: string;
  ts: number;
  /** The hash of the previous anchor, so anchors cannot be dropped from the middle. */
  prev: string;
  keyId: string;
  sig: string;
}

const GENESIS = "0".repeat(64);
const message = (a: Omit<AuditAnchor, "sig">): string => JSON.stringify([a.n, a.seq, a.hash, a.ts, a.prev, a.keyId]);
export const anchorHash = (a: AuditAnchor): string => createHash("sha256").update(message(a)).update(a.sig).digest("hex");

/** Append-only file of anchors, one JSON object per line, readable only by its owner. */
export class AnchorLog {
  constructor(readonly path: string) {}

  list(): AuditAnchor[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((line, i) => {
      try { return JSON.parse(line) as AuditAnchor; } catch { throw new Error(`anchor ${i + 1} in ${this.path} is not readable`); }
    });
  }

  latest(): AuditAnchor | undefined {
    return this.list().at(-1);
  }

  append(anchor: AuditAnchor): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(anchor)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

export interface AnchorerOptions {
  log: AnchorLog;
  key: AuditKey;
  /** Anchor after this many new entries. Default 50. */
  every?: number;
  now?: () => number;
}

/** Signs the journal's head into the anchor log as it grows. Attach with `journal.onAppend(anchorer.observe)`. */
export class AuditAnchorer {
  private readonly every: number;
  private readonly now: () => number;
  private last: AuditAnchor | undefined;

  constructor(private readonly journal: EventJournal, private readonly o: AnchorerOptions) {
    this.every = o.every ?? 50;
    this.now = o.now ?? Date.now;
    this.last = o.log.latest();
    journal.onAppend((entry) => this.observe(entry));
  }

  private observe(entry: JournalEntry): void {
    if (entry.seq - (this.last?.seq ?? 0) >= this.every) this.anchor();
  }

  /** Anchors the current head now (also used at shutdown and by `august audit anchor`). Returns undefined when nothing is new. */
  anchor(): AuditAnchor | undefined {
    const head = this.journal.head();
    if (!head || head.seq === (this.last?.seq ?? 0)) return undefined;
    const body = { n: (this.last?.n ?? 0) + 1, seq: head.seq, hash: head.hash, ts: this.now(), prev: this.last ? anchorHash(this.last) : GENESIS, keyId: this.o.key.id };
    const anchor: AuditAnchor = { ...body, sig: this.o.key.sign(message(body)) };
    this.o.log.append(anchor);
    this.last = anchor;
    return anchor;
  }
}

export interface AuditReport {
  ok: boolean;
  /** The journal's own hash chain. */
  chainBrokenAt: number | null;
  anchors: number;
  /** The newest entry the anchors vouch for. */
  anchoredThrough: number;
  /** Entries after the last anchor: intact as far as the chain goes, but not yet vouched for. */
  unanchored: number;
  problems: string[];
}

/**
 * Checks the journal against its anchors: the chain is intact, every anchor is signed by the expected key and links
 * to the one before it, every anchored entry still has the hash that was signed, and the journal has not been cut
 * back behind its newest anchor.
 */
export function verifyAudit(journal: EventJournal, anchors: readonly AuditAnchor[], publicKeyDer: Buffer, expectedKeyId?: string): AuditReport {
  const problems: string[] = [];
  const chainBrokenAt = journal.verify();
  if (chainBrokenAt !== null) problems.push(`the journal's hash chain is broken at entry ${chainBrokenAt}`);
  let prev = GENESIS; let lastSeq = 0;
  anchors.forEach((a, i) => {
    const { sig: _sig, ...body } = a;
    if (a.n !== i + 1) problems.push(`anchor ${i + 1} is out of order or an anchor is missing before it`);
    if (a.prev !== prev) problems.push(`anchor ${a.n} does not follow the one before it`);
    if (expectedKeyId && a.keyId !== expectedKeyId) problems.push(`anchor ${a.n} was signed by a different key (${a.keyId})`);
    else if (!verifyAnchorSignature(publicKeyDer, message(body), a.sig)) problems.push(`anchor ${a.n} has an invalid signature`);
    if (a.seq <= lastSeq) problems.push(`anchor ${a.n} does not advance the journal`);
    const entry = journal.entry(a.seq);
    if (!entry) problems.push(`entry ${a.seq}, vouched for by anchor ${a.n}, is gone from the journal`);
    else if (entry.hash !== a.hash) problems.push(`entry ${a.seq} differs from what anchor ${a.n} signed`);
    prev = anchorHash(a); lastSeq = a.seq;
  });
  const head = journal.head();
  return { ok: problems.length === 0, chainBrokenAt, anchors: anchors.length, anchoredThrough: lastSeq, unanchored: Math.max(0, (head?.seq ?? 0) - lastSeq), problems };
}
