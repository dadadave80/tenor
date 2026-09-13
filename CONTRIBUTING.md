# Contributing to Tenor

Tenor is an ETHOnline 2026 project running on Hedera testnet. Contributions are welcome; small,
focused pull requests are the easiest to review.

## Setup

```bash
git clone --recursive https://github.com/dadadave80/tenor
cd tenor
bun install
```

The clone must be recursive: Lattice vendors `diamond-lib` and `forge-std` as its own submodules,
and `git submodule add` does not recurse. If you already cloned flat, run
`git submodule update --init --recursive`.

Contracts:

```bash
cd contracts
forge build
forge test
```

Web client:

```bash
bun run --filter web dev
```

The testnet scripts need a funded Hedera testnet ECDSA key in `contracts/.env` (see `.env.example`).
Nothing in CI needs one.

## Before you open a pull request

CI runs these checks. Run them locally first:

| Check | Command |
|---|---|
| Solidity formatting | `cd contracts && forge fmt --check` |
| Contracts build and tests | `cd contracts && forge build && forge test` |
| Generated ABIs are current | `bun run gen:abi && git diff --exit-code -- apps/web/lib/abi.ts` |
| Web typecheck | `bun run --filter web typecheck` |
| Script imports resolve | `for f in scripts/*.ts; do bun build --target=node "$f" --outfile /dev/null; done` |

If you change a contract's ABI, run `bun run gen:abi` and commit `apps/web/lib/abi.ts` with it.

## Conventions

- Commits follow Conventional Commits with a scope, as the history does: `feat(web): …`,
  `fix(scripts): …`, `chore(deploy): …`, `feat(contracts): …`. Keep them small and frequent.
- Solidity is formatted by `forge fmt` (120 columns, 4-space indent; see `contracts/foundry.toml`).
  TypeScript is formatted by Prettier.
- Read `docs/GROUND-TRUTH.md` before touching Lattice, ATS or Hedera system-contract calls. It
  records what those APIs actually do, read from source, and the deviations from the spec that
  followed.
- Tenor contains no compliance logic on purpose. A change that lets the market, rather than the
  token, decide whether a transfer is allowed is a design change: open an issue first.
- Redeploying the diamond is not part of a normal pull request. Deployment records live in
  `deployments/` and change only through the deploy scripts.

## Bugs and security issues

Bugs: open a GitHub issue with the transaction hash or a reproduction.
Security issues: see [SECURITY.md](SECURITY.md). Do not open a public issue.
