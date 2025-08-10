import { NetworkId } from '@sonarwatch/portfolio-core';
import { Connection, FetchMiddleware } from '@solana/web3.js';
import { RPC_BACKOFF_MS, RPC_RETRIES, RPC_FETCH_CONCURRENCY } from '../config';
import { getBasicAuthHeaders } from '../misc/getBasicAuthHeaders';
import { getRpcEndpoint } from './constants';
import { SolanaClient } from './types';

export default function getClientSolana(): SolanaClient {
  const rpcEndpoint = getRpcEndpoint(NetworkId.solana);
  const httpHeaders = rpcEndpoint.basicAuth
    ? getBasicAuthHeaders(
        rpcEndpoint.basicAuth.username,
        rpcEndpoint.basicAuth.password
      )
    : undefined;

  let fetchMiddleware: FetchMiddleware | undefined;
  if ((globalThis as any)?.process?.env?.['PORTFOLIO_RPC_LOGS'] === 'true') {
    const reqs: Record<string, number> = {
      total: 0,
    };
    // Add a small HTTP-layer concurrency gate + backoff for 429/503
    let inflight = 0;
    const queue: Array<() => void> = [];
    const acquire = async () =>
      new Promise<void>((resolve) => {
        if (inflight < RPC_FETCH_CONCURRENCY) {
          inflight += 1;
          resolve();
        } else {
          queue.push(() => {
            inflight += 1;
            resolve();
          });
        }
      });
    const release = () => {
      inflight -= 1;
      const next = queue.shift();
      if (next) next();
    };

    fetchMiddleware = async (info: RequestInfo, init: RequestInit | undefined, fetch: typeof globalThis.fetch) => {
      const { method } = JSON.parse(init?.body?.toString() || '{}');
      if (typeof method !== 'string') return;
      if (!reqs[method]) reqs[method] = 0;
      reqs[method] += 1;
      reqs['total'] += 1;
      if (reqs['total'] % 5 === 1) {
        // eslint-disable-next-line no-console
        console.log(`RPC Requests: ${JSON.stringify(reqs, undefined, 2)}`);
      }
      // Concurrency + retry
      await acquire();
      try {
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const res = await fetch(info, init);
          if (res.status !== 429 && res.status !== 503) return res;
          if (attempt >= RPC_RETRIES) return res;
          const delay = RPC_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          attempt += 1;
        }
      } finally {
        release();
      }
    };
  }

  return new Connection(rpcEndpoint.url, {
    httpHeaders,
    fetchMiddleware,
  });
}

// Optional: use a separate Helius RPC just for activity scanning to offload from main RPC
export function getActivitySolanaClient(): SolanaClient {
  const heliusUrl = (globalThis as any)?.process?.env?.['PORTFOLIO_SOLANA_HELIUS_RPC'];
  if (!heliusUrl) return getClientSolana();

  let fetchMiddleware: FetchMiddleware | undefined;
  if ((globalThis as any)?.process?.env?.['PORTFOLIO_RPC_LOGS'] === 'true') {
    const reqs: Record<string, number> = { total: 0 };
    // Minimal logging wrapper
    fetchMiddleware = async (info: RequestInfo, init: RequestInit | undefined, fetch: typeof globalThis.fetch) => {
      const { method } = JSON.parse(init?.body?.toString() || '{}');
      if (typeof method === 'string') {
        if (!reqs[method]) reqs[method] = 0;
        reqs[method] += 1;
        reqs['total'] += 1;
      }
      return fetch(info, init);
    };
  }
  return new Connection(heliusUrl, { fetchMiddleware });
}
