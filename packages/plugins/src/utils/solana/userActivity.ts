import { Connection, PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import { Cache, getCache } from '../../Cache';
import {
  USER_ACTIVITY_BACKSTOP_MS,
  USER_ACTIVITY_MAX_TXS,
  USER_ACTIVITY_HARD_LIMIT,
  USER_PROGRAM_CACHE_TTL_MS,
  USER_PROGRAM_CACHE_LONG_TTL_MS,
  USER_GLOBAL_SIGS_TTL_MS,
} from '../config';

export type ProgramUserActivity = {
  lastSeenSignature?: string;
  lastSeenSlot?: number;
  lastRebuiltAt?: number;
};

export type ProgramUserCache = {
  accountPubkeys: string[];
  activity: ProgramUserActivity;
};

// Stores per (programId x user) activity cursors & discovered pubkeys in the process memory.
// For production, back this with Redis using the existing Cache abstraction if needed.
// Redis-backed store via Cache for program-user PDA lists (no in-process storage)
const programUserPrefix = 'program-user-pdas';

export async function getProgramUserCacheFromStore(
  cache: Cache,
  programId: string,
  user: string
): Promise<ProgramUserCache | undefined> {
  const k = `${programId}:${user}`;
  const v = await cache.getItem<ProgramUserCache>(k, {
    prefix: programUserPrefix,
  });
  return v;
}

export async function setProgramUserCacheToStore(
  cache: Cache,
  programId: string,
  user: string,
  value: ProgramUserCache
) {
  const k = `${programId}:${user}`;
  await cache.setItem(k, value, {
    prefix: programUserPrefix,
    ttl: USER_PROGRAM_CACHE_TTL_MS,
  });
}

// Convenience wrappers that always use Redis via a cache instance
export async function getProgramUserCache(programId: string, user: string): Promise<ProgramUserCache | undefined> {
  const cache = getCache();
  return getProgramUserCacheFromStore(cache, programId, user);
}

export async function setProgramUserCache(programId: string, user: string, value: ProgramUserCache): Promise<void> {
  const cache = getCache();
  await setProgramUserCacheToStore(cache, programId, user, value);
}

// Per-user last computed timestamp (for entire portfolio) stored in Redis
const userLastComputedPrefix = 'user-last-computed';

export async function setUserLastComputed(cache: Cache, user: string, timestampMs: number) {
  await cache.setItem(user, timestampMs, { prefix: userLastComputedPrefix, ttl: USER_PROGRAM_CACHE_TTL_MS });
}

export async function getUserLastComputed(cache: Cache, user: string): Promise<number | undefined> {
  return cache.getItem<number>(user, { prefix: userLastComputedPrefix });
}

// Global per-user activity cursor (last seen signature/slot/blockTime)
const userActivityCursorPrefix = 'user-activity-cursor';
export type UserActivityCursor = {
  lastSeenSignature?: string;
  lastSeenSlot?: number;
  lastSeenBlockTime?: number;
};

export async function getUserActivityCursor(cache: Cache, user: string): Promise<UserActivityCursor | undefined> {
  return cache.getItem<UserActivityCursor>(user, { prefix: userActivityCursorPrefix });
}

export async function setUserActivityCursor(cache: Cache, user: string, cursor: UserActivityCursor) {
  await cache.setItem(user, cursor, { prefix: userActivityCursorPrefix, ttl: USER_PROGRAM_CACHE_TTL_MS });
}

// Compute programs touched since last cursor; update cursor; return set of programIds
export async function updateUserActivityAndGetTouchedPrograms(
  connection: Connection,
  cache: Cache,
  user: PublicKey
): Promise<{ touchedPrograms: Set<string>; newCursor: UserActivityCursor }> {
  const prev = await getUserActivityCursor(cache, user.toBase58());
  const sigs = await connection.getSignaturesForAddress(user, {
    until: prev?.lastSeenSignature,
    limit: USER_ACTIVITY_HARD_LIMIT,
  });
  const newCursor: UserActivityCursor = {
    lastSeenSignature: sigs[0]?.signature || prev?.lastSeenSignature,
    lastSeenSlot: sigs[0]?.slot || prev?.lastSeenSlot,
    lastSeenBlockTime: sigs[0]?.blockTime || prev?.lastSeenBlockTime,
  };
  if (sigs.length === 0) return { touchedPrograms: new Set<string>(), newCursor };
  const parsed = await loadParsedTransactions(
    connection,
    sigs.map((s) => s.signature)
  );
  const touched = new Set<string>();
  parsed.forEach((tx) => {
    if (!tx) return;
    try {
      // Only consider txns actually signed by the user
      const keys = (tx.transaction.message.accountKeys || []) as any[];
      const userBase58 = user.toBase58();
      const userSigned = keys.some((k: any) => {
        const pk = typeof k === 'string' ? k : String(k.pubkey);
        const isSigner = typeof k === 'object' ? !!k.signer : false;
        return isSigner && pk === userBase58;
      });
      if (!userSigned) return;

      const instrs = tx.transaction.message.instructions || [];
      instrs.forEach((ix: any) => touched.add(String(ix.programId)));
      const inner = tx.meta?.innerInstructions || [];
      inner.forEach((ii: any) =>
        (ii.instructions || []).forEach((ix: any) => touched.add(String(ix.programId)))
      );
    } catch (_e) {}
  });
  await setUserActivityCursor(cache, user.toBase58(), newCursor);
  return { touchedPrograms: touched, newCursor };
}

// Helper: decide whether to rebuild in foreground or background based on whether
// there is a cached result. If cached, update cursor and trigger background rebuild; otherwise do foreground.
export type RebuildMode = 'foreground' | 'background' | 'skip';
export function chooseRebuildMode(
  hasCachedElements: boolean,
  tooManyNewTxs: boolean
): RebuildMode {
  if (!tooManyNewTxs) return hasCachedElements ? 'background' : 'foreground';
  // If there are more than hard limit txs, prefer background if cache exists, otherwise foreground
  return hasCachedElements ? 'background' : 'foreground';
}

// Optionally extend PDA cache TTL to long TTL when there is no activity for a long time
export async function maybeExtendProgramUserCacheTtl(
  cache: Cache,
  programId: string,
  user: string,
  cursor: UserActivityCursor
) {
  const k = `${programId}:${user}`;
  // If lastSeenBlockTime older than 30 days, rewrite item with a longer TTL
  const THIRTY_DAYS_MS = USER_PROGRAM_CACHE_LONG_TTL_MS;
  const last = cursor.lastSeenBlockTime ? cursor.lastSeenBlockTime * 1000 : 0;
  if (last && Date.now() - last > THIRTY_DAYS_MS) {
    const v = await cache.getItem<ProgramUserCache>(k, { prefix: programUserPrefix });
    if (v) {
      await cache.setItem(k, v, { prefix: programUserPrefix, ttl: USER_PROGRAM_CACHE_LONG_TTL_MS });
    }
  }
}

export async function getNewUserSignatures(
  connection: Connection,
  user: PublicKey,
  sinceSignature?: string,
  limit: number = USER_ACTIVITY_MAX_TXS
): Promise<ConfirmedSignatureInfo[]> {
  const sigs = await connection.getSignaturesForAddress(user, {
    before: undefined,
    until: sinceSignature,
    limit,
  });
  return sigs;
}

export async function loadParsedTransactions(
  connection: Connection,
  signatures: string[]
): Promise<(ParsedTransactionWithMeta | null)[]> {
  const results: (ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < signatures.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const tx = await connection.getParsedTransaction(signatures[i], {
      maxSupportedTransactionVersion: 0,
    });
    results.push(tx);
  }
  return results;
}

export function parsedTxTouchesProgram(
  tx: ParsedTransactionWithMeta | null,
  programId: PublicKey
): boolean {
  if (!tx || !tx.transaction) return false;
  try {
    const instrs = tx.transaction.message.instructions || [];
    return instrs.some((ix: any) => `${ix.programId}` === `${programId}`);
  } catch (_e) {
    return false;
  }
}

export async function shouldRebuildAccounts(
  connection: Connection,
  user: PublicKey,
  programId: PublicKey,
  cache: ProgramUserCache | undefined
): Promise<{
  needRebuild: boolean;
  activity: ProgramUserActivity;
  touchingSigs: string[];
}> {
  const now = Date.now();
  const lastRebuiltAt = cache?.activity.lastRebuiltAt || 0;
  const backstopDue = now - lastRebuiltAt > USER_ACTIVITY_BACKSTOP_MS;
  // Prefer global per-request activity context
  const { programTouchedInRequest } = await import('./requestContext');
  if (programTouchedInRequest(user, programId)) {
    // Request-level activity already computed; no need to refetch/parse here.
    // Use request context cursor if available; fall back to cache.
    const { getUserRequestActivity } = await import('./requestContext');
    const req = getUserRequestActivity(user);
    const activity: ProgramUserActivity = {
      lastSeenSignature: req?.lastSeenSignature || cache?.activity.lastSeenSignature,
      lastSeenSlot: req?.lastSeenSlot || cache?.activity.lastSeenSlot,
      lastRebuiltAt: now,
    };
    return { needRebuild: true, activity, touchingSigs: [] };
  }

  const sigs = await getNewUserSignatures(
    connection,
    user,
    cache?.activity.lastSeenSignature
  );
  if (sigs.length === 0) {
    return {
      needRebuild: backstopDue,
      activity: { lastSeenSignature: cache?.activity.lastSeenSignature, lastSeenSlot: cache?.activity.lastSeenSlot, lastRebuiltAt },
      touchingSigs: [],
    };
  }

  const parsed = await loadParsedTransactions(
    connection,
    sigs.map((s) => s.signature)
  );
  const touching: string[] = [];
  parsed.forEach((tx, i) => {
    if (parsedTxTouchesProgram(tx, programId)) touching.push(sigs[i].signature);
  });

  const activity: ProgramUserActivity = {
    lastSeenSignature: sigs[0]?.signature || cache?.activity.lastSeenSignature,
    lastSeenSlot: sigs[0]?.slot || cache?.activity.lastSeenSlot,
    lastRebuiltAt: touching.length > 0 ? now : lastRebuiltAt,
  };

  return {
    needRebuild: touching.length > 0 || backstopDue,
    activity,
    touchingSigs: touching,
  };
}

// Global per-request cache for user signatures to share across protocols
const globalUserSigs = new Map<string, { sigs: ConfirmedSignatureInfo[]; fetchedAt: number }>();

export async function getGlobalUserSignatures(
  connection: Connection,
  user: PublicKey
): Promise<ConfirmedSignatureInfo[]> {
  const k = user.toBase58();
  const hit = globalUserSigs.get(k);
  if (hit && Date.now() - hit.fetchedAt < USER_GLOBAL_SIGS_TTL_MS) return hit.sigs;
  const sigs = await connection.getSignaturesForAddress(user, { limit: USER_ACTIVITY_MAX_TXS });
  globalUserSigs.set(k, { sigs, fetchedAt: Date.now() });
  return sigs;
}


