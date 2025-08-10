import {
  Connection,
  GetProgramAccountsFilter,
  PublicKey,
  KeyedAccountInfo,
} from '@solana/web3.js';
import { getProgramAccounts } from './getProgramAccounts';
import { GlobalBeetStruct, ParsedAccount } from './types';
import { withRpcLimit, withGpaRateLimit } from './rpcLimiter';
import { withRpcRetry } from './rpcRetry';
import { getMultipleAccountsBatched } from './getMultipleAccountsBatched';
import {
  getProgramUserCache,
  setProgramUserCache,
  getProgramUserCacheFromStore,
  setProgramUserCacheToStore,
  shouldRebuildAccounts,
} from './userActivity';
import { getAnyUserRequestActivity } from './requestContext';

export async function getParsedProgramAccounts<T>(
  connection: Connection,
  beetStruct: GlobalBeetStruct<T>,
  programId: PublicKey,
  filters: GetProgramAccountsFilter[] | undefined = undefined,
  maxAccounts = -1
) {
  const useTwoStep = process.env['PORTFOLIO_SOLANA_TWO_STEP_GPA'] === 'true';

  // Attempt to extract owner from filters or request context
  let ownerStr: string | undefined;
  if (filters) {
    for (const f of filters) {
      // @ts-expect-error partial type narrowing for memcmp filter
      const mm = (f as any)?.memcmp;
      if (mm && typeof mm.bytes === 'string' && mm.bytes.length >= 32) {
        ownerStr = mm.bytes;
        break;
      }
    }
  }
  if (!ownerStr) {
    const req = getAnyUserRequestActivity();
    if (req) ownerStr = req.owner.toBase58();
  }

  // If we can identify an owner, use Redis-only PDA cache and activity gate
  if (ownerStr) {
    const programKey = programId.toBase58();
    const prev = (await getProgramUserCache(programKey, ownerStr)) ||
      (await getProgramUserCacheFromStore((await import('../..')).getCache?.() as any, programKey, ownerStr));
    const ownerPk = new PublicKey(ownerStr);

    const activityCheck = await shouldRebuildAccounts(
      connection,
      ownerPk,
      programId,
      prev
    );

    if (prev && !activityCheck.needRebuild) {
      const pubkeys = (prev.accountPubkeys || []).map((k) => new PublicKey(k));
      const accountsInfo = await getMultipleAccountsBatched(connection, pubkeys);
      return accountsInfo
        .map((info, i) => {
          if (!info) return null as any;
          const [parsed] = beetStruct.deserialize(info.data);
          return {
            pubkey: pubkeys[i],
            lamports: info.lamports,
            ...parsed,
          } as ParsedAccount<T>;
        })
        .filter(Boolean);
    }

    // Rebuild path: GPA only for pubkeys, then batch fetch; persist to Redis
    const pubkeyOnly = (await withGpaRateLimit(() =>
      withRpcRetry(() =>
        connection.getProgramAccounts(programId, {
          commitment: 'confirmed',
          encoding: 'base64',
          filters,
          dataSlice: { offset: 0, length: 0 },
        })
      )
    )) as unknown as { pubkey: PublicKey }[];
    if (maxAccounts > 0 && pubkeyOnly.length > maxAccounts) {
      throw new Error(`Too much accounts to get (${pubkeyOnly.length})`);
    }
    const pubkeys = pubkeyOnly.map((a) => a.pubkey);
    const accountsInfo = await getMultipleAccountsBatched(connection, pubkeys);
    const parsedAccounts = accountsInfo
      .map((info, i) => {
        if (!info) return null as any;
        const [parsed] = beetStruct.deserialize(info.data);
        return {
          pubkey: pubkeys[i],
          lamports: info.lamports,
          ...parsed,
        } as ParsedAccount<T>;
      })
      .filter(Boolean);
    const storeVal = {
      accountPubkeys: pubkeys.map((k) => k.toBase58()),
      activity: activityCheck.activity,
    };
    await setProgramUserCache(programKey, ownerStr, storeVal);
    await setProgramUserCacheToStore((await import('../..')).getCache?.() as any, programKey, ownerStr, storeVal);
    return parsedAccounts;
  }

  if (!useTwoStep) {
    const accountsRes = await getProgramAccounts(
      connection,
      programId,
      filters,
      maxAccounts
    );
    return (accountsRes as { pubkey: PublicKey; account: KeyedAccountInfo['account'] }[]).map(
      (accountRes) =>
        ({
          pubkey: accountRes.pubkey,
          lamports: accountRes.account.lamports,
          ...beetStruct.deserialize(accountRes.account.data)[0],
        } as ParsedAccount<T>)
    );
  }

  // Two-step: first only pubkeys, then batched getMultipleAccountsInfo
  const pubkeyOnly = (await withGpaRateLimit(() =>
    withRpcRetry(() =>
      connection.getProgramAccounts(programId, {
        commitment: 'confirmed',
        encoding: 'base64',
        filters,
        dataSlice: { offset: 0, length: 0 },
      })
    )
  )) as unknown as { pubkey: PublicKey }[];

  if (maxAccounts > 0 && pubkeyOnly.length > maxAccounts) {
    throw new Error(`Too much accounts to get (${pubkeyOnly.length})`);
  }

  const pubkeys = pubkeyOnly.map((a) => a.pubkey);
  const accountsInfo = await getMultipleAccountsBatched(connection, pubkeys);
  return accountsInfo.map((info, i) => {
    if (!info) return null as any;
    const [parsed] = beetStruct.deserialize(info.data);
    return {
      pubkey: pubkeys[i],
      lamports: info.lamports,
      ...parsed,
    } as ParsedAccount<T>;
  }).filter(Boolean);
}
