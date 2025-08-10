import {
  Commitment,
  Connection,
  GetMultipleAccountsConfig,
  PublicKey,
} from '@solana/web3.js';
import { withRpcLimit } from './rpcLimiter';

const MAX_ACCOUNT = 100;

export async function getMultipleAccountsInfoSafe(
  connection: Connection,
  publicKeys: PublicKey[],
  commitmentOrConfig?: Commitment | GetMultipleAccountsConfig
) {
  if (publicKeys.length <= MAX_ACCOUNT) {
    return (await withRpcLimit(() =>
      connection.getMultipleAccountsInfo(publicKeys, commitmentOrConfig)
    )) as unknown as any[];
  }
  const accountsInfo = [];
  const publicKeysToFetch = [...publicKeys];
  while (publicKeysToFetch.length !== 0) {
    const currPublicKeysToFetch = publicKeysToFetch.splice(0, MAX_ACCOUNT);
    const accountsInfoRes = (await withRpcLimit(() =>
      connection.getMultipleAccountsInfo(
        currPublicKeysToFetch,
        commitmentOrConfig
      )
    )) as unknown as any[];
    accountsInfo.push(...(accountsInfoRes as any[]));
  }
  return accountsInfo;
}
