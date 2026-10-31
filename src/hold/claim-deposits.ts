// The factory of deposit addresses (apps/contracts, 27 Oct 2026), as the hold sees it: it names
// the deposit address of each claim by transfer, and the claim wallet, its operator, settles a
// deposit whose claim went through, burning at most the burn of one claim and sending the rest back
// to the wallet, or refunds all of a deposit to its wallet. The contract allows nothing else, so
// THKR sent to a deposit is never Thinkr's. Top-ups in USDG use it too (credit/usdg-wallet.ts), with
// the wallet that receives top-ups as the wallet of each deposit. node/claim-deposits.ts reaches the
// chain.

export interface ClaimDeposits {
  /** The deposit address that the factory names for the claim `claimId` of `wallet`, in lower case. */
  depositAddress: (wallet: string, claimId: string) => Promise<string>;
  /**
   * Settles the deposit of a claim that went through. Resolves with the THKR that it burned, or
   * with null when the deposit settled before, whose burn the count reads from the chain instead.
   * `deposit` is the address that the claim named, which says the factory of a claim from before.
   */
  settle: (wallet: string, claimId: string, deposit: string) => Promise<bigint | null>;
  /** Sends all of the token `asset` in the deposit of a claim to its wallet. */
  refund: (wallet: string, claimId: string, deposit: string, asset: string) => Promise<void>;
}

/**
 * The factory of a claim: this one when it names the deposit of the claim, or else the one before
 * it, which still settles and refunds the deposits of its claims. Addresses are in lower case.
 */
export async function factoryOfClaim(
  factories: { readonly current: string; readonly retired: string | null },
  namedBy: (factory: string) => Promise<string>,
  deposit: string,
): Promise<string> {
  if (factories.retired === null) return factories.current;
  return (await namedBy(factories.current)).toLowerCase() === deposit
    ? factories.current
    : factories.retired;
}

/** A random id of a claim at the factory, `bytes` long, as 0x hex. */
export function newClaimId(bytes: number): string {
  const id = crypto.getRandomValues(new Uint8Array(bytes));
  return `0x${Array.from(id, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
