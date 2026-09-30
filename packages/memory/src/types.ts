import type { ContentOrigin, Sensitivity } from "@august/policy";

/**
 * Working: scratch for the current job, gone within a day. Episodic: what happened, kept for a bounded time.
 * Semantic: facts and preferences the owner wants remembered. Procedural: how the owner wants things done.
 */
export const MEMORY_CLASSES = ["working", "episodic", "semantic", "procedural"] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

export const isMemoryClass = (v: unknown): v is MemoryClass => typeof v === "string" && (MEMORY_CLASSES as readonly string[]).includes(v);

/** Who may be believed when this entry is read back. An untrusted entry taints whatever reads it. */
export type MemoryTrust = "trusted" | "untrusted";

export interface MemoryEntry {
  id: string;
  /** The owner's session key: nothing is ever readable outside it. */
  scope: string;
  class: MemoryClass;
  text: string;
  origin: ContentOrigin;
  trust: MemoryTrust;
  sensitivity: Sensitivity;
  /** The run that wrote it, when a run did. */
  sourceRun?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  useCount: number;
  status: "active" | "superseded";
  /** The first entry of the chain this one replaces; deleting any link deletes the whole chain. */
  lineage: string;
  supersedes?: string;
}

export interface MemoryInput {
  scope: string;
  class: MemoryClass;
  text: string;
  origin: ContentOrigin;
  trust: MemoryTrust;
  sensitivity: Sensitivity;
  sourceRun?: string;
  /** Milliseconds from now; defaults per class. */
  ttlMs?: number;
  /** Replace this entry (same scope): the old text stays listed as superseded until forgotten. */
  supersedes?: string;
}

export interface Tombstone {
  id: string;
  scope: string;
  class: MemoryClass;
  deletedAt: number;
  /** Why it went, never what it said. */
  reason: string;
}

export interface RecallOptions {
  signal?: AbortSignal;
  scope: string;
  query: string;
  classes?: readonly MemoryClass[];
  limit?: number;
  /** Leave out entries that were written after reading untrusted content. */
  trustedOnly?: boolean;
  /** Count this as a use (recency and frequency raise an entry's rank). Default true. */
  touch?: boolean;
}

export interface RecallHit {
  entry: MemoryEntry;
  score: number;
}
