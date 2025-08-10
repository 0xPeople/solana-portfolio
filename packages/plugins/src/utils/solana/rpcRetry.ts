// Exponential backoff retry helper for RPC calls

type Fn<T> = () => Promise<T>;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRpcRetry<T>(fn: Fn<T>): Promise<T> {
  const defaultRetries = 2;
  const defaultBackoffMs = 250;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (globalThis as any)?.process?.env as Record<string, string | undefined> | undefined;
  const retries = parseInt((env?.['PORTFOLIO_RPC_RETRIES'] ?? `${defaultRetries}`) as string, 10);
  const backoffMs = parseInt((env?.['PORTFOLIO_RPC_BACKOFF_MS'] ?? `${defaultBackoffMs}`) as string, 10);

  let attempt = 0;
  let delay = backoffMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const message = (err && (err.message || err.toString())) || '';
      const isRetryable =
        message.includes('429') ||
        message.includes('503') ||
        message.includes('Rate limit') ||
        message.includes('Too Many Requests') ||
        message.includes('gateway') ||
        message.includes('ECONNRESET') ||
        message.includes('ETIMEDOUT') ||
        message.includes('socket hang up');

      if (attempt >= retries || !isRetryable) throw err;
      await sleep(delay);
      attempt += 1;
      delay *= 2;
    }
  }
}


