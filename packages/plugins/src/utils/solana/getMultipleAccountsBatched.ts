import { Commitment, Connection, GetMultipleAccountsConfig, PublicKey } from '@solana/web3.js';
import { withRpcLimit } from './rpcLimiter';
import { withRpcRetry } from './rpcRetry';

export async function getMultipleAccountsBatched(
  connection: Connection,
  publicKeys: PublicKey[],
  commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
) {
  if (publicKeys.length === 0) return [];
  const defaultBatch = 100;
  const batchSize = parseInt(process.env['PORTFOLIO_RPC_FETCH_CONCURRENCY'] || `${defaultBatch}`, 10);
  const step = Number.isFinite(batchSize) ? Math.max(1, batchSize) : defaultBatch;

  const results: (Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>[number] | null)[] = [];
  for (let offset = 0; offset < publicKeys.length; offset += step) {
    const slice = publicKeys.slice(offset, offset + step);
    // Limit and retry per slice
    // eslint-disable-next-line no-await-in-loop
    const infos = await withRpcLimit(() =>
      withRpcRetry(() => connection.getMultipleAccountsInfo(slice, commitmentOrConfig))
    );
    results.push(...infos);
  }
  return results;
}



