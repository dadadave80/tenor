'use client'

import { useAccount, useBalance, useReadContract, useReadContracts } from 'wagmi'
import { atsTokenAbi, tenorAbi } from './abi'
import { addresses, HTS_SYSTEM_CONTRACT } from './chain'

/**
 * Everything the action buttons need to know before a transaction is worth simulating.
 *
 * These are deliberately READS, not discoveries from `simulateContract`, because `fill()` reverts in
 * contract order and contract order is the wrong order to tell a human about. SPEC §5.2 runs the USDC
 * transfer before `executeHoldByPartition`, so a buyer with no KYC and no allowance simulating a fill
 * is told "Approve USDC" first — they would sign an approval, pay for it, and only then learn they
 * were never eligible. Compliance is a property of the account, so it is read and reported up front;
 * simulation stays as the net for everything reads cannot see.
 */

/** `IKyc.KycStatus`: 0 = NOT_GRANTED, 1 = GRANTED. */
const KYC_GRANTED = 1

export type Readiness = {
  /** No wallet connected. Every other field is meaningless until this is false. */
  disconnected: boolean
  /** Still fetching. Buttons show their pending label rather than a wrong one. */
  loading: boolean
  address?: `0x${string}`
  /** HBAR, 18 dp on the EVM side. Gas for every transaction, including HTS association. */
  hbar: bigint
  /** Whether this account is associated with USDC. An HTS transfer to an unassociated account fails. */
  usdcAssociated: boolean
  usdc: bigint
  /** USDC the account has approved to the Tenor diamond — what `fill` spends. */
  usdcAllowance: bigint
  /** Security-token balance in the traded partition. */
  tokens: bigint
  /** Security tokens the account has approved to the diamond — what `list` reserves via a hold. */
  tokenAllowance: bigint
  verified: boolean
  frozen: boolean
  /** In the token's control list. `isWhiteList: false` at issuance, so presence means blocked. */
  blocked: boolean
  /** The ATS token's own pause. Stops every transfer, so it stops fills. */
  tokenPaused: boolean
  /** Tenor's pause. Listings stay reserved and cancellable. */
  marketPaused: boolean
}

const EMPTY: Readiness = {
  disconnected: true,
  loading: false,
  hbar: 0n,
  usdcAssociated: false,
  usdc: 0n,
  usdcAllowance: 0n,
  tokens: 0n,
  tokenAllowance: 0n,
  verified: false,
  frozen: false,
  blocked: false,
  tokenPaused: false,
  marketPaused: false,
}

export function useReadiness(): Readiness {
  const { address } = useAccount()
  const { tenor, token, usdc } = addresses
  const on = Boolean(address && tenor && token && usdc)

  const { data: bal } = useBalance({ address, query: { enabled: Boolean(address) } })

  // One multicall rather than eleven round trips: the drawer re-reads these on every keystroke
  // through the amount field, and eleven requests per keystroke is how a relay starts rate-limiting.
  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: token, abi: atsTokenAbi, functionName: 'getKycStatusFor', args: [address!] },
      { address: token, abi: atsTokenAbi, functionName: 'isFrozen', args: [address!] },
      { address: token, abi: atsTokenAbi, functionName: 'isInControlList', args: [address!] },
      { address: token, abi: atsTokenAbi, functionName: 'paused' },
      { address: tenor, abi: tenorAbi, functionName: 'paused' },
      { address: token, abi: atsTokenAbi, functionName: 'balanceOf', args: [address!] },
      { address: token, abi: atsTokenAbi, functionName: 'allowance', args: [address!, tenor!] },
      // USDC is an HTS token, so its EVM address answers the ERC-20 facade directly.
      { address: usdc, abi: erc20, functionName: 'balanceOf', args: [address!] },
      { address: usdc, abi: erc20, functionName: 'allowance', args: [address!, tenor!] },
    ],
    query: { enabled: on },
  })

  // HIP-719's `isAssociated()` takes no arguments and answers for `msg.sender`, and the vendored HTS
  // ABI has no address-taking equivalent -- so this one cannot join the multicall above, which has
  // no per-call `account`. Read from the zero address it would answer for the wrong account.
  const { data: associated } = useReadContract({
    address: usdc,
    abi: hrc719,
    functionName: 'isAssociated',
    account: address,
    query: { enabled: on },
  })

  if (!address) return EMPTY
  if (!tenor || !token || !usdc) return { ...EMPTY, disconnected: false, address }

  const at = <T,>(i: number, fallback: T): T => (data?.[i]?.status === 'success' ? (data[i].result as T) : fallback)

  return {
    disconnected: false,
    loading: isLoading,
    address,
    hbar: bal?.value ?? 0n,
    verified: Number(at<bigint | number>(0, 0)) === KYC_GRANTED,
    frozen: at<boolean>(1, false),
    blocked: at<boolean>(2, false),
    tokenPaused: at<boolean>(3, false),
    marketPaused: at<boolean>(4, false),
    tokens: at<bigint>(5, 0n),
    tokenAllowance: at<bigint>(6, 0n),
    usdc: at<bigint>(7, 0n),
    usdcAllowance: at<bigint>(8, 0n),
    usdcAssociated: associated ?? false,
  }
}

/** Minimal ERC-20 reads. HTS tokens answer these at their own EVM address. */
const erc20 = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const

/** HIP-719: every HTS token address exposes this facade, and it answers for `msg.sender`. */
const hrc719 = [
  { type: 'function', name: 'isAssociated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'associate', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

export { erc20 as erc20Abi, hrc719 as hrc719Abi }

/** `HTS_SYSTEM_CONTRACT` is re-exported so callers do not need two imports for one association. */
export { HTS_SYSTEM_CONTRACT }

/** Reads one listing. Kept separate because the fill drawer needs it to re-read after a partial fill. */
export function useListing(id?: bigint) {
  return useReadContract({
    address: addresses.tenor,
    abi: tenorAbi,
    functionName: 'getListing',
    args: id === undefined ? undefined : [id],
    query: { enabled: Boolean(addresses.tenor && id !== undefined) },
  })
}
