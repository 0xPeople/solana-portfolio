import { NetworkId, PortfolioElementType } from '@sonarwatch/portfolio-core';
import { PublicKey } from '@solana/web3.js';
import { Cache } from '../../Cache';
import { Fetcher, FetcherExecutor } from '../../Fetcher';
import { platformId, pythMint, stakingProgramId } from './constants';
import { getClientSolana } from '../../utils/clients';
import { ParsedAccount, TokenAccount, tokenAccountStruct } from '../../utils/solana';
import { positionsDataFilter } from './filters';
import { getParsedAccountInfo } from '../../utils/solana/getParsedAccountInfo';
import tokenPriceToAssetToken from '../../utils/misc/tokenPriceToAssetToken';

const executor: FetcherExecutor = async (owner: string, cache: Cache) => {
  const client = getClientSolana();

  // Activity-gated: only run GPA on first-time or when user had Pyth staking activity
  const ownerPk = new PublicKey(owner);
  const { getProgramUserCache, setProgramUserCache, shouldRebuildAccounts } = await import(
    '../../utils/solana/userActivity'
  );

  const programKey = stakingProgramId.toBase58();
  const prevMem = getProgramUserCache(programKey, owner);
  const prev = prevMem || (await (await import('../../utils/solana/userActivity')).getProgramUserCacheFromStore(cache, programKey, owner));
  const activityCheck = await shouldRebuildAccounts(
    client,
    ownerPk,
    stakingProgramId,
    prev
  );

  let stakingAccounts: { pubkey: PublicKey }[];
  if (!prev || activityCheck.needRebuild) {
    stakingAccounts = (await client.getProgramAccounts(stakingProgramId, {
      filters: positionsDataFilter(owner),
      dataSlice: { offset: 0, length: 0 },
    })) as { pubkey: PublicKey }[];
    const toStore = {
      accountPubkeys: stakingAccounts.map((a) => a.pubkey.toBase58()),
      activity: activityCheck.activity,
    };
    setProgramUserCache(programKey, owner, toStore);
    const { setProgramUserCacheToStore } = await import('../../utils/solana/userActivity');
    await setProgramUserCacheToStore(cache, programKey, owner, toStore);
  } else {
    stakingAccounts = (prev.accountPubkeys || []).map((k) => ({
      pubkey: new PublicKey(k),
    }));
  }

  const tokenPrice = await cache.getTokenPrice(pythMint, NetworkId.solana);

  if (stakingAccounts.length !== 1) return [];

  const seed = new TextEncoder().encode('custody');
  const tokenAccount = PublicKey.findProgramAddressSync(
    [seed, stakingAccounts[0].pubkey.toBuffer()],
    stakingProgramId
  )[0];

  const tokenAccountInfo = (await getParsedAccountInfo(
    client,
    tokenAccountStruct,
    tokenAccount
  )) as ParsedAccount<TokenAccount> | null;

  const amount = tokenAccountInfo?.amount;
  if (!amount || amount.isZero()) return [];

  const asset = tokenPriceToAssetToken(
    pythMint,
    amount.dividedBy(10 ** 6).toNumber(),
    NetworkId.solana,
    tokenPrice
  );

  return [
    {
      type: PortfolioElementType.multiple,
      label: 'Staked',
      networkId: NetworkId.solana,
      platformId,
      data: { assets: [asset] },
      value: asset.value,
    },
  ];
};

const fetcher: Fetcher = {
  id: `${platformId}-staking`,
  networkId: NetworkId.solana,
  executor,
};

export default fetcher;
