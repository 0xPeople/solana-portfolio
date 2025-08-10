import {
  AddressSystemType,
  FetcherReport,
  FetcherResult,
  FetchersResult,
  NetworkIdType,
  PortfolioElement,
  formatAddress,
  formatAddressByNetworkId,
  getUsdValueSum,
  networks,
  sortPortfolioElement,
} from '@sonarwatch/portfolio-core';
import { Cache } from './Cache';
import { FETCHERS_CONCURRENCY, FETCHER_RESULT_TTL_SEC } from './utils/config';
import runInParallel from './utils/misc/runInParallel';
import { getActivitySolanaClient } from './utils/clients/getClientSolana';
import { setUserRequestActivity } from './utils/solana/requestContext';
import { updateUserActivityAndGetTouchedPrograms } from './utils/solana/userActivity';
import { setUserLastComputed } from './utils/solana/userActivity';
import promiseTimeout from './utils/misc/promiseTimeout';

const runFetcherTimeout = 60000;

export type FetcherExecutor = (
  owner: string,
  cache: Cache
) => Promise<PortfolioElement[]>;

export type Fetcher = {
  id: string;
  networkId: NetworkIdType;
  executor: FetcherExecutor;
};

export async function runFetchers(
  owner: string,
  addressSystem: AddressSystemType,
  fetchers: Fetcher[],
  cache: Cache
): Promise<FetchersResult> {
  const fOwner = formatAddress(owner, addressSystem);
  const isFetchersValids = fetchers.every(
    (f) => networks[f.networkId].addressSystem === addressSystem
  );
  if (!isFetchersValids)
    throw new Error(
      `Not all fetchers have the right address system: ${addressSystem}`
    );

  const startDate = Date.now();
  // Global per-request user activity: prefetch user signatures once and warm cache
  try {
    if (addressSystem === 'solana') {
      const c = getActivitySolanaClient();
      const { PublicKey } = await import('@solana/web3.js');
      const ownerPk = new PublicKey(fOwner);
      // One-shot: compute touched programs since last cursor; update cursor in Redis
      const { touchedPrograms, newCursor } = await updateUserActivityAndGetTouchedPrograms(c, cache, ownerPk);
      setUserRequestActivity({
        owner: ownerPk,
        touchedPrograms,
        lastSeenSignature: newCursor.lastSeenSignature,
        lastSeenSlot: newCursor.lastSeenSlot,
        createdAt: Date.now(),
      });
    }
  } catch (_e) {
    // ignore prefetch failures
  }
  // Execute fetchers with a global concurrency cap
  const result = await runInParallel(
    fetchers.map((f) => () => runFetcher(fOwner, f, cache)),
    FETCHERS_CONCURRENCY
  );

  const fReports: FetcherReport[] = [];
  const elements = result.flatMap((r, index) => {
    let fReport: FetcherReport;
    if (r.status === 'fulfilled') {
      fReport = {
        id: fetchers[index].id,
        status: 'succeeded',
        duration: r.value.duration,
        error: undefined,
      };
    } else {
      fReport = {
        id: fetchers[index].id,
        status: 'failed',
        duration: undefined,
        error: r.reason.message || 'Unknown error',
      };
    }
    fReports.push(fReport);

    if (r.status === 'rejected') return [];
    return r.value.elements;
  });
  return {
    date: Date.now(),
    owner: fOwner,
    addressSystem,
    fetcherReports: fReports,
    value: getUsdValueSum(elements.map((e) => e.value)),
    elements,
    duration: Date.now() - startDate,
  };
}

export async function runFetchersByNetworkId(
  owner: string,
  networkId: NetworkIdType,
  fetchers: Fetcher[],
  cache: Cache
) {
  const isFetchersValids = fetchers.every((f) => f.networkId === networkId);
  if (!isFetchersValids)
    throw new Error(`Not all fetchers have the right network id: ${networkId}`);

  const { addressSystem } = networks[networkId];
  return runFetchers(owner, addressSystem, fetchers, cache);
}

export async function runFetcher(
  owner: string,
  fetcher: Fetcher,
  cache: Cache
): Promise<FetcherResult> {
  const startDate = Date.now();
  const fOwner = formatAddressByNetworkId(owner, fetcher.networkId);
  // Persist per-user last computed timestamp
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  setUserLastComputed(cache, fOwner, Date.now());
  const cacheKey = `${fetcher.id}:${fOwner}`;
  const cachedElements = await cache.getItem<PortfolioElement[]>(cacheKey, {
    prefix: 'fetcher-result',
  });

  const fetcherPromise = (async () => {
    if (cachedElements && cachedElements.length > 0) {
      return {
        owner: fOwner,
        fetcherId: fetcher.id,
        networdkId: fetcher.networkId,
        duration: 0,
        elements: cachedElements.map((e) => sortPortfolioElement(e)),
      } as FetcherResult;
    }
    const elements = await fetcher.executor(fOwner, cache);
    const sorted = elements.map((e) => sortPortfolioElement(e));
    await cache.setItem(cacheKey, sorted, {
      prefix: 'fetcher-result',
      ttl: FETCHER_RESULT_TTL_SEC * 1000,
    });
    return {
      owner: fOwner,
      fetcherId: fetcher.id,
      networdkId: fetcher.networkId,
      duration: Date.now() - startDate,
      elements: sorted,
    } as FetcherResult;
  })();
  return promiseTimeout(
    fetcherPromise,
    runFetcherTimeout,
    `Fetcher timed out: ${fetcher.id}`
  );
}
