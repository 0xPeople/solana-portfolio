/* Centralized env configuration with sane defaults */

export function getNumberEnv(
  name: string,
  defaultValue: number
): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export function getBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw === 'true' || raw === '1';
}

// Global concurrency and retry knobs
export const FETCHERS_CONCURRENCY = getNumberEnv(
  'PORTFOLIO_FETCHERS_CONCURRENCY',
  6
);
export const RPC_FETCH_CONCURRENCY = getNumberEnv(
  'PORTFOLIO_RPC_FETCH_CONCURRENCY',
  12
);
export const SOLANA_RPC_CONCURRENCY = getNumberEnv(
  'PORTFOLIO_SOLANA_RPC_CONCURRENCY',
  8
);
export const RPC_RETRIES = getNumberEnv('PORTFOLIO_RPC_RETRIES', 2);
export const RPC_BACKOFF_MS = getNumberEnv('PORTFOLIO_RPC_BACKOFF_MS', 250);

// GPA memoization TTL (ms)
export const GPA_CACHE_TTL_MS = getNumberEnv('PORTFOLIO_GPA_CACHE_TTL_MS', 15000);
export const GPA_RPS_LIMIT = getNumberEnv('PORTFOLIO_GPA_RPS', 30);

// User activity gating
export const USER_ACTIVITY_MAX_TXS = getNumberEnv(
  'PORTFOLIO_USER_ACTIVITY_MAX_TXS',
  4
);
export const USER_ACTIVITY_HARD_LIMIT = getNumberEnv(
  'PORTFOLIO_USER_ACTIVITY_HARD_LIMIT',
  20
);
export const USER_ACTIVITY_BACKSTOP_MS = getNumberEnv(
  'PORTFOLIO_USER_ACTIVITY_BACKSTOP_MS',
  48 * 60 * 60 * 1000
);

// Program-user PDA cache TTL (default 7 days)
export const USER_PROGRAM_CACHE_TTL_MS = getNumberEnv(
  'PORTFOLIO_USER_PROGRAM_CACHE_TTL_MS',
  7 * 24 * 60 * 60 * 1000
);

// Long TTL for wallets without recent activity
export const USER_PROGRAM_CACHE_LONG_TTL_MS = getNumberEnv(
  'PORTFOLIO_USER_PROGRAM_CACHE_LONG_TTL_MS',
  30 * 24 * 60 * 60 * 1000
);

// Global user signatures prefetch TTL (short-lived, in ms)
export const USER_GLOBAL_SIGS_TTL_MS = getNumberEnv(
  'PORTFOLIO_USER_GLOBAL_SIGS_TTL_MS',
  15_000
);

// Fetcher result cache TTL (sec)
export const FETCHER_RESULT_TTL_SEC = getNumberEnv(
  'PORTFOLIO_FETCHER_RESULT_TTL_SEC',
  900
);


