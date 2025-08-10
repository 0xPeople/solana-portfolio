import { PublicKey } from '@solana/web3.js';

export type UserRequestActivity = {
  owner: PublicKey;
  touchedPrograms: Set<string>; // base58 programIds
  lastSeenSignature?: string;
  lastSeenSlot?: number;
  createdAt: number;
};

const ctx = new Map<string, UserRequestActivity>();
let lastOwnerKey: string | null = null;

export function setUserRequestActivity(activity: UserRequestActivity) {
  ctx.set(activity.owner.toBase58(), activity);
  lastOwnerKey = activity.owner.toBase58();
}

export function getUserRequestActivity(owner: PublicKey): UserRequestActivity | undefined {
  return ctx.get(owner.toBase58());
}

export function programTouchedInRequest(owner: PublicKey, programId: PublicKey): boolean {
  const a = getUserRequestActivity(owner);
  if (!a) return false;
  return a.touchedPrograms.has(programId.toBase58());
}

export function getAnyUserRequestActivity(): UserRequestActivity | undefined {
  if (lastOwnerKey) return ctx.get(lastOwnerKey);
  const i = ctx.values().next();
  return i.done ? undefined : i.value;
}


