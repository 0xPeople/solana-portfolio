// GPA-only rate limiter (token bucket) and a generic semaphore used elsewhere only when explicitly called.

type Release = () => void;

class Semaphore {
  private readonly maxConcurrency: number;
  private activeCount: number = 0;
  private queue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  async acquire(): Promise<Release> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return () => this.release();
    }

    return new Promise<Release>((resolve) => {
      this.queue.push(() => {
        this.activeCount += 1;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.activeCount -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

let globalSemaphore: Semaphore | null = null;

function getEnv(): Record<string, string | undefined> {
  // Avoid direct process typing to keep linter happy without @types/node
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (globalThis as any)?.process?.env as Record<string, string | undefined> | undefined;
  return env || {};
}

export function getRpcSemaphore(): Semaphore {
  if (globalSemaphore) return globalSemaphore;
  const defaultConcurrency = 8;
  const envValue = getEnv()['PORTFOLIO_SOLANA_RPC_CONCURRENCY'];
  const concurrency = envValue ? parseInt(envValue, 10) : defaultConcurrency;
  globalSemaphore = new Semaphore(Number.isFinite(concurrency) ? concurrency : defaultConcurrency);
  return globalSemaphore;
}

export async function withRpcLimit<T>(fn: () => Promise<T>): Promise<T> {
  const release = await getRpcSemaphore().acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// GPA-only token bucket limiter: enforce ~GPA_RPS_LIMIT
let tokens = 0;
let lastRefill = Date.now();
let refillTimer: any = null;
let configuredRps = 30;

function configureGpaRps(rps: number) {
  configuredRps = Math.max(1, rps);
  tokens = configuredRps;
  lastRefill = Date.now();
  if (refillTimer) clearInterval(refillTimer);
  refillTimer = setInterval(() => {
    // Refill per second
    tokens = configuredRps;
    lastRefill = Date.now();
  }, 1000);
}

export async function withGpaRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (configuredRps <= 0) {
    // lazy init from env config
    try {
      const { GPA_RPS_LIMIT } = await import('../config');
      configureGpaRps(GPA_RPS_LIMIT);
    } catch (_e) {
      configureGpaRps(30);
    }
  }
  // spin-wait minimally to obtain a token
  // keep latency low, but enforce ~RPS
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (tokens > 0) {
      tokens -= 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return fn();
}


