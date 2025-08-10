import { GetProgramAccountsFilter, PublicKey } from '@solana/web3.js';

type CacheEntry = {
  value: any;
  expiresAt: number;
};

// In-process short-lived memoization for identical GPA calls
const map = new Map<string, CacheEntry>();

function getTtlMs(): number {
  const defaultTtl = 15000;
  const envTtl = process.env['PORTFOLIO_GPA_CACHE_TTL_MS'];
  const n = envTtl ? parseInt(envTtl, 10) : defaultTtl;
  return Number.isFinite(n) ? n : defaultTtl;
}

function buildKey(programId: PublicKey, filters?: GetProgramAccountsFilter[]) {
  return `${programId.toBase58()}::${JSON.stringify(filters || [])}`;
}

export function getGpaMemo(programId: PublicKey, filters?: GetProgramAccountsFilter[]) {
  const key = buildKey(programId, filters);
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

export function setGpaMemo(programId: PublicKey, filters: GetProgramAccountsFilter[] | undefined, value: any) {
  const key = buildKey(programId, filters);
  const ttl = getTtlMs();
  map.set(key, { value, expiresAt: Date.now() + ttl });
}



