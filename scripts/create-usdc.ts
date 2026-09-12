/**
 * M1 step 1b — create the demo USDC that the market settles in and coupons are paid in.
 *
 * Nothing else in the project creates this token, and everything downstream needs it: `TenorInit`
 * takes it as a constructor-ish argument, the diamond associates with it, `fill` moves it between
 * buyer and seller, `fundCoupon` pulls it from the issuer, and the faucet route drips it. So it has
 * to exist before `DeployTenor` runs.
 *
 * This is a genuine HTS token rather than a Solidity ERC-20, because that is the whole point of the
 * exercise: `TenorHTS.transferFrom` goes to the Hedera Token Service at `0x167`, and an HTS token is
 * what has an association requirement and an allowance the system contract can spend. A Solidity
 * mock would quietly bypass the path being demonstrated.
 *
 * The operator is treasury, admin key and supply key, so the faucet can mint and drip later.
 *
 * Usage:  bun run create:usdc
 */
import {
  AccountId,
  Client,
  PrivateKey,
  TokenCreateTransaction,
  TokenId,
  TokenSupplyType,
  TokenType,
} from '@hashgraph/sdk'
import { DEFAULT_MIRROR, operator, scan, writeRecord } from './lib/ats'

const DECIMALS = 6
const INITIAL_SUPPLY = 100_000_000n * 10n ** BigInt(DECIMALS) // 100M demo USDC for faucet drips

const { address } = await operator()

/**
 * Resolves the Hedera account id for an EVM address.
 *
 * The SDK's native operations are keyed by account id (`0.0.x`), not by EVM address, so the mirror
 * node is the bridge. A freshly funded EVM address only gets an account id once it has received
 * HBAR, which is why this fails loudly rather than guessing.
 */
async function accountIdFor(evmAddress: string): Promise<AccountId> {
  const res = await fetch(`${DEFAULT_MIRROR}/accounts/${evmAddress}`)
  if (!res.ok) {
    throw new Error(
      `Mirror node has no account for ${evmAddress} (HTTP ${res.status}). ` +
        `A Hedera account is only created once the address receives HBAR — fund it first. ` +
        `Mirror-node lag is a few seconds, so retry shortly after funding.`,
    )
  }
  const body = (await res.json()) as { account?: string }
  if (!body.account) throw new Error(`Mirror node returned no account id for ${evmAddress}`)
  return AccountId.fromString(body.account)
}

const pk = process.env.PRIVATE_KEY ?? process.env.HEDERA_TESTNET_PRIVATE_KEY_0
if (!pk) throw new Error('Set PRIVATE_KEY in contracts/.env')

const operatorId = await accountIdFor(address)
// The operator key is an EVM-style ECDSA key, so it must be parsed as ECDSA, not ED25519.
const operatorKey = PrivateKey.fromStringECDSA(pk)

console.log(`operator account ${operatorId.toString()}  (${address})`)

const client = Client.forTestnet().setOperator(operatorId, operatorKey)

try {
  const tx = await new TokenCreateTransaction()
    .setTokenName('Tenor Demo USDC')
    .setTokenSymbol('USDC')
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(DECIMALS)
    .setInitialSupply(INITIAL_SUPPLY)
    .setTreasuryAccountId(operatorId)
    .setAdminKey(operatorKey)
    // Supply key so the faucet can mint more if the demo drains the treasury.
    .setSupplyKey(operatorKey)
    .setSupplyType(TokenSupplyType.Infinite)
    .setTokenMemo('Tenor demo settlement asset — Hedera testnet only, no value.')
    .execute(client)

  const receipt = await tx.getReceipt(client)
  const tokenId = receipt.tokenId
  if (!tokenId) throw new Error('TokenCreateTransaction returned no tokenId')

  // Every HTS token is reachable from the EVM at its long-zero address, which is the form every
  // Solidity `address` argument and every `0x167` call expects.
  const evm = `0x${TokenId.fromString(tokenId.toString()).toSolidityAddress()}`

  writeRecord({ usdc: evm })

  console.log(`
demo USDC created

  token id    ${tokenId.toString()}
  EVM address ${evm}
              ${scan('token', tokenId.toString())}
  decimals    ${DECIMALS}
  supply      ${INITIAL_SUPPLY} (100,000,000.000000)
  treasury    ${operatorId.toString()}  — admin + supply key, so the faucet can drip and mint

next:  bun run issue:bond
`)
} finally {
  client.close()
}
