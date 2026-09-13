# Security policy

Tenor is deployed on **Hedera testnet only**. There is no mainnet deployment, no real funds and no
bug bounty. Reports are still welcome: the contracts are written as if they will hold money.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and
choose **Report a vulnerability**. Include the affected contract or component, a transaction hash or
a reproduction, and the impact as you understand it.

You will get an acknowledgement when the maintainer sees the report, and a fix or a written
assessment as soon as one exists. This is a single-maintainer project, so response is best effort.

## Scope

In scope:

- `contracts/src/`: the Tenor diamond (`TenorMarket`, `TenorCoupon`, `TenorHTS`, the initializer
  and the factory).
- `scripts/`: deployment and issuance tooling.
- `apps/web/`: the client, including the faucet API route.

Out of scope, report upstream instead:

- [Lattice](https://github.com/dadadave80/lattice) modules, including the HTS and HSS adapters.
- [Asset Tokenization Studio](https://github.com/hashgraph/asset-tokenization-studio) contracts.
- Hedera network and system-contract behaviour.

## Known limitations

`docs/GROUND-TRUTH.md` §8 lists reviewed and accepted limitations, and §10 records the one gate
that does not fully pass: the scheduled coupon call fails `INVALID_PAYER_SIGNATURE`, so settlement
is completed by the permissionless `payCoupon`. Reports that restate these will be closed with a
pointer there.

## Notes for reviewers

- The market never holds a security token. A listing is an ATS hold with the diamond as escrow, so
  the diamond's balance of any security token should always be zero.
- Tenor contains no compliance logic. Every transfer is decided by the token's own KYC, control
  list, pause and freeze checks inside `executeHoldByPartition`.
- `payCoupon` is permissionless and idempotent by design. Being able to call it is not a finding.
