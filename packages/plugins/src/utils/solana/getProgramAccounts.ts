import {
  Connection,
  GetProgramAccountsConfig,
  GetProgramAccountsFilter,
  PublicKey,
} from '@solana/web3.js';
import { withGpaRateLimit } from './rpcLimiter';
import { withRpcRetry } from './rpcRetry';
import { getGpaMemo, setGpaMemo } from './gpaMemo';

export async function getProgramAccounts(
  connection: Connection,
  programId: PublicKey,
  filters?: GetProgramAccountsFilter[],
  maxAccounts = 0
) {
  const config: GetProgramAccountsConfig = {
    commitment: 'confirmed',
    encoding: 'base64',
    filters,
  };

  const memoHit = getGpaMemo(programId, filters);
  if (memoHit) return memoHit as any[];

  if (maxAccounts <= 0)
    return (await withGpaRateLimit(() =>
      withRpcRetry(() => connection.getProgramAccounts(programId, config))
    )) as any[];

  const accountsRes = (await withGpaRateLimit(() =>
    withRpcRetry(() =>
      connection.getProgramAccounts(programId, {
        ...config,
        dataSlice: { offset: 0, length: 0 },
      })
    )
  )) as unknown as any[];
  if (accountsRes.length > maxAccounts)
    throw new Error(`Too much accounts to get (${accountsRes.length})`);

  const res = (await withGpaRateLimit(() =>
    withRpcRetry(() => connection.getProgramAccounts(programId, config))
  )) as any[];
  setGpaMemo(programId, filters || [], res);
  return res;
}
