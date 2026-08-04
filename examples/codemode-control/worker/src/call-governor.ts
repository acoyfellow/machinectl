export interface GovernorLimits {
  maxCalls: number;
  perCallTimeoutMs: number;
}

export interface GovernorMetrics {
  calls: number;
  rejected: number;
}

export const DEFAULT_GOVERNOR_LIMITS: GovernorLimits = { maxCalls: 64, perCallTimeoutMs: 20_000 };

export class CallLimitReached extends Error {
  constructor(limit: number) {
    super(`Code Mode call budget of ${limit} upstream calls was reached for this execution`);
    this.name = "CallLimitReached";
  }
}

export class CallTimedOut extends Error {
  constructor(tool: string, timeoutMs: number) {
    super(`Upstream call to ${tool} exceeded ${timeoutMs}ms`);
    this.name = "CallTimedOut";
  }
}

export class CallGovernor {
  private calls = 0;
  private rejected = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly limits: GovernorLimits = DEFAULT_GOVERNOR_LIMITS) {}

  get metrics(): GovernorMetrics {
    return { calls: this.calls, rejected: this.rejected };
  }

  run<T>(tool: string, operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.then(async () => {
      if (this.calls >= this.limits.maxCalls) {
        this.rejected += 1;
        throw new CallLimitReached(this.limits.maxCalls);
      }
      this.calls += 1;
      return await this.withTimeout(tool, operation);
    });
    this.tail = queued.catch(() => undefined);
    return queued;
  }

  private async withTimeout<T>(tool: string, operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new CallTimedOut(tool, this.limits.perCallTimeoutMs)), this.limits.perCallTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export async function catalogHash(names: readonly string[]): Promise<string> {
  const canonical = [...names].sort().join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
