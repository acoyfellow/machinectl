export type OpResult = { ok: true; content: string } | { ok: false; error: string };

export interface OpLedgerOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

type Entry = { promise: Promise<OpResult>; settledAt?: number };

export class OpLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: OpLedgerOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  run(opId: string | undefined, work: () => Promise<OpResult>): { promise: Promise<OpResult>; replayed: boolean } {
    if (!opId) return { promise: work(), replayed: false };
    this.evict();
    const existing = this.entries.get(opId);
    if (existing) return { promise: existing.promise, replayed: true };
    const entry: Entry = { promise: work() };
    entry.promise = entry.promise.then((result) => {
      entry.settledAt = this.now();
      return result;
    });
    this.entries.set(opId, entry);
    return { promise: entry.promise, replayed: false };
  }

  size(): number {
    return this.entries.size;
  }

  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [opId, entry] of this.entries) {
      if (entry.settledAt !== undefined && entry.settledAt < cutoff) this.entries.delete(opId);
    }
    for (const [opId, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.settledAt !== undefined) this.entries.delete(opId);
    }
  }
}
