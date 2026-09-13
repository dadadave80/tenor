/**
 * The issuer's compliance console — KYC, freeze, pause and the control list, from one command.
 *
 * Demo beat 5 needs two things to happen on camera in a few seconds: a buyer stops being able to
 * buy, and the market stops trading. Both are issuer-only ATS calls with no UI anywhere in Tenor,
 * on purpose: a button in the app would imply an authority the visitor does not have.
 *
 * Every mutating subcommand prints its transaction hash and HashScan link, then re-reads the chain
 * and prints the resulting state — so what goes on camera is a read, never this script's own claim.
 *
 * One thing to know before filming, read from ATS 8.0.0 source rather than assumed:
 * `ERC3643StorageWrapper.setAddressFrozen` does NOT write the frozen-token ledger. It toggles the
 * CONTROL LIST — `addToControlList` on a blocklist token, which is what `issue-bond.ts` created
 * (`isWhiteList: false`). So on this token `freeze` and `control-list add` are the same storage,
 * and `IFreeze.isFrozen` — which reads `frozenTokens[account] > 0`, the partial-freeze amount — stays
 * false throughout. The transfer is refused with `AccountIsBlocked`, which `lib/errors.ts` labels
 * "Account blocked". `status` therefore prints the control list as the thing that actually moved.
 *
 * Usage:  bun run issuer status [address]
 *         bun run issuer kyc grant|revoke <address>
 *         bun run issuer freeze|unfreeze <address>
 *         bun run issuer pause|unpause
 *         bun run issuer control-list add|remove <address>
 */
import { getAddress, isAddress } from 'ethers'
import {
  IAccessControl__factory,
  IControlList__factory,
  IERC20__factory,
  IFreeze__factory,
  IKyc__factory,
  IPause__factory,
  ISsiManagement__factory,
} from '@hashgraph/asset-tokenization-contracts/typechain-types'
import { ROLES } from '@hashgraph/asset-tokenization-contracts/scripts'
import { operator, requireRecord, scan } from './lib/ats'

const USAGE = `Usage:
  bun run issuer status [address]              token pause state; with an address, its KYC, freeze,
                                               control list and bond balance
  bun run issuer kyc grant <address>           verify an investor
  bun run issuer kyc revoke <address>          withdraw verification
  bun run issuer freeze <address>              stop an account transacting in the bond
  bun run issuer unfreeze <address>            let it transact again
  bun run issuer pause                         halt all transfers of the bond
  bun run issuer unpause                       resume them
  bun run issuer control-list add <address>    block an account
  bun run issuer control-list remove <address> unblock it`

/** ATS `IKyc.KycStatus`. */
const KYC_GRANTED = 1n

/**
 * Explicit gas, because Hedera's relay under-estimates calls into the ATS diamond.
 *
 * Found the hard way: `setAddressFrozen(issuer, false)` passed `eth_estimateGas` and then reverted
 * on chain having burnt exactly its estimate, 80,019 gas — an out-of-gas with no revert data, which
 * reads as a compliance refusal and is not one. The same trap `retire-diamond.ts` documents.
 */
const GAS = 1_000_000n

function fail(message?: string): never {
  if (message) console.error(`${message}\n`)
  console.error(USAGE)
  process.exit(1)
}

function want(arg: string | undefined): string {
  if (!arg || !isAddress(arg)) fail(`Expected an EVM address, got ${arg ? `"${arg}"` : 'nothing'}.`)
  return getAddress(arg as string)
}

const COMMANDS = ['status', 'kyc', 'freeze', 'unfreeze', 'pause', 'unpause', 'control-list']

const args = process.argv.slice(2).filter((a) => a !== '--')
const [cmd, ...rest] = args
// Checked before the signer is built, so a typo costs a usage message rather than an RPC round trip.
if (!cmd || !COMMANDS.includes(cmd)) fail(cmd ? `Unknown command "${cmd}".` : undefined)

const { token, decimals } = requireRecord(['token', 'decimals'])
const { signer, address: issuer } = await operator()

const kyc = IKyc__factory.connect(token, signer)
const freeze = IFreeze__factory.connect(token, signer)
const pause = IPause__factory.connect(token, signer)
const controlList = IControlList__factory.connect(token, signer)
const access = IAccessControl__factory.connect(token, signer)
const erc20 = IERC20__factory.connect(token, signer)

const units = (v: bigint) => `${(Number(v) / 10 ** decimals).toLocaleString('en-US')} TGN27`

/**
 * Grants the issuer a token role it is missing, using its DEFAULT_ADMIN_ROLE.
 *
 * `issue-bond.ts` granted the whole set at issuance, so this is a safety net for a token issued
 * some other way rather than the normal path — which is why it announces itself.
 */
async function ensureRole(role: string, name: string): Promise<void> {
  if (await access.hasRole(role, issuer)) return
  // ATS's `grantRole` is itself `onlyUnpaused`, so a missing role cannot be repaired while paused.
  if (await pause.paused()) {
    fail(
      `${issuer} does not hold ${name}, and ATS's grantRole is onlyUnpaused, so it cannot be ` +
        `granted while the token is paused. Unpause from an account that holds ROLE_PAUSER first.`,
    )
  }
  console.log(`\n${issuer} does not hold ${name} — granting it first with DEFAULT_ADMIN_ROLE.`)
  await send(`grantRole(${name})`, access.grantRole(role, issuer, { gasLimit: GAS }))
}

async function send(label: string, p: Promise<{ hash: string; wait: () => Promise<unknown> }>) {
  const tx = await p
  console.log(`\n  ${label}`)
  console.log(`  tx    ${tx.hash}`)
  console.log(`        ${scan('transaction', tx.hash)}`)
  await tx.wait()
  return tx
}

async function printStatus(who?: string): Promise<void> {
  const isPaused = await pause.paused()
  console.log(`\ntoken   ${token}`)
  console.log(`        ${scan('contract', token)}`)
  console.log(`paused  ${isPaused}${isPaused ? '   → the market shows "Trading paused by issuer"' : ''}`)
  if (!who) return

  const [status, listed, frozenTokens, isFrozen, balance] = await Promise.all([
    kyc.getKycStatusFor(who),
    controlList.isInControlList(who),
    freeze.getFrozenTokens(who),
    freeze.isFrozen(who),
    erc20.balanceOf(who),
  ])
  console.log(`\naccount ${who}`)
  console.log(`  kyc            ${status === KYC_GRANTED ? 'GRANTED' : 'NOT_GRANTED'}`)
  console.log(
    `  control list   ${listed ? 'ON   → transfers refused with AccountIsBlocked' : 'off'}` +
      `   (this is what \`freeze\` toggles on this token)`,
  )
  console.log(`  frozen tokens  ${units(frozenTokens)}   (IFreeze.isFrozen ${isFrozen})`)
  console.log(`  balance        ${units(balance)}`)
}

/** Every subcommand but `pause`/`unpause` is `onlyUnpaused` on chain, so say so plainly up front. */
async function refuseIfPaused(): Promise<void> {
  if (await pause.paused()) {
    fail('The token is paused, and every other issuer call is onlyUnpaused. Run `bun run issuer unpause` first.')
  }
}

switch (cmd) {
  case 'status': {
    await printStatus(rest[0] ? want(rest[0]) : undefined)
    break
  }

  case 'kyc': {
    const [sub, addr] = rest
    if (sub !== 'grant' && sub !== 'revoke') fail(`Unknown kyc subcommand "${sub ?? ''}" — expected grant or revoke.`)
    const who = want(addr)
    await refuseIfPaused()
    await ensureRole(ROLES.ROLE_KYC, 'ROLE_KYC')

    const status = await kyc.getKycStatusFor(who)
    if (sub === 'grant') {
      // `grantKyc` on an already-verified account reverts `InvalidKycStatus()` — the SAME error an
      // unverified holder's transfer gives, so it is checked rather than retried.
      if (status === KYC_GRANTED) {
        console.log(`\n${who} is already verified — nothing to do.`)
        break
      }
      // The last argument is the KYC ISSUER, checked against the token's SSI issuer registry rather
      // than against a role: an unregistered address reverts `AccountIsNotIssuer(address)` even
      // holding every KYC role. `bun run grant:kyc` registers the operator.
      const ssi = ISsiManagement__factory.connect(token, signer)
      if (!(await ssi.isIssuer(issuer))) {
        fail(`${issuer} is not in the token's SSI issuer registry, so it cannot sign a KYC grant. Run \`bun run grant:kyc\`.`)
      }
      const now = BigInt(Math.floor(Date.now() / 1000))
      await send(
        `grantKyc(${who})`,
        kyc.grantKyc(who, `tenor-demo-${who.slice(2, 10)}`, now, now + 5n * 365n * 24n * 60n * 60n, issuer, {
          gasLimit: GAS,
        }),
      )
    } else {
      if (status !== KYC_GRANTED) {
        console.log(`\n${who} is not verified — nothing to revoke.`)
        break
      }
      await send(`revokeKyc(${who})`, kyc.revokeKyc(who, { gasLimit: GAS }))
    }
    await printStatus(who)
    break
  }

  case 'freeze':
  case 'unfreeze': {
    const who = want(rest[0])
    await refuseIfPaused()
    await ensureRole(ROLES.ROLE_FREEZE_MANAGER, 'ROLE_FREEZE_MANAGER')

    // `setAddressFrozen` writes the control list (see the header), so that is what says whether the
    // account is already where we are trying to put it. Repeating the call reverts `ListedAccount`
    // or `UnlistedAccount`, which on camera looks like the tool is broken.
    const on = cmd === 'freeze'
    if ((await controlList.isInControlList(who)) === on) {
      console.log(`\n${who} is already ${on ? 'frozen' : 'unfrozen'} — nothing to do.`)
      await printStatus(who)
      break
    }
    await send(`setAddressFrozen(${who}, ${on})`, freeze.setAddressFrozen(who, on, { gasLimit: GAS }))
    await printStatus(who)
    break
  }

  case 'pause':
  case 'unpause': {
    if (rest.length) fail(`\`${cmd}\` takes no arguments.`)
    await ensureRole(ROLES.ROLE_PAUSER, 'ROLE_PAUSER')

    // `pause` is `onlyUnpaused` and `unpause` is `onlyPaused`, so both revert when the token is
    // already where it is being asked to go.
    const on = cmd === 'pause'
    if ((await pause.paused()) === on) {
      console.log(`\nthe token is already ${on ? 'paused' : 'unpaused'} — nothing to do.`)
      await printStatus()
      break
    }
    await send(
      cmd === 'pause' ? 'pause()' : 'unpause()',
      on ? pause.pause({ gasLimit: GAS }) : pause.unpause({ gasLimit: GAS }),
    )
    await printStatus()
    break
  }

  case 'control-list': {
    const [sub, addr] = rest
    if (sub !== 'add' && sub !== 'remove') fail(`Unknown control-list subcommand "${sub ?? ''}" — expected add or remove.`)
    const who = want(addr)
    await refuseIfPaused()
    await ensureRole(ROLES.ROLE_CONTROL_LIST, 'ROLE_CONTROL_LIST')

    const on = sub === 'add'
    if ((await controlList.isInControlList(who)) === on) {
      console.log(`\n${who} is already ${on ? 'on' : 'off'} the control list — nothing to do.`)
      await printStatus(who)
      break
    }
    await send(
      on ? `addToControlList(${who})` : `removeFromControlList(${who})`,
      on ? controlList.addToControlList(who, { gasLimit: GAS }) : controlList.removeFromControlList(who, { gasLimit: GAS }),
    )
    await printStatus(who)
    break
  }

  default:
    fail(`Unknown command "${cmd}".`)
}
