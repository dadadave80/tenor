# Design

The visual design lives in a **Claude Design** project and is the source of truth for tokens,
typography, component shapes and copy.

| | |
|---|---|
| Project | `692ca674-6c56-4e88-829c-6d6375f084f5` |
| Canvas | https://claude.ai/design/p/692ca674-6c56-4e88-829c-6d6375f084f5 |
| Files | `Tenor Landing.dc.html` · `Tenor v2.dc.html` · `Tenor Components.dc.html` · `Tenor Frames.dc.html` · `Tenor.dc.html` · `tokens.css` · `brand/tenor-ribbon.png` |

Reading it needs design-system authorization (`/design-login`), after which the `DesignSync` tool's
`list_files` / `get_file` return the canvas contents. The canvas is **not** a Code artifact, so the
`Artifact` tool rejects its URL and an unauthenticated fetch gets a 403.

## What was imported, and where it landed

| From the canvas | In this repo |
|---|---|
| `tokens.css` | `apps/web/app/tokens.css` — **verbatim**, both palettes |
| the `<helmet>` base styles and keyframes | `apps/web/app/globals.css` |
| `brand/tenor-ribbon.png` | `apps/web/public/brand/tenor-ribbon.png` |
| `Tenor Landing.dc.html` | `apps/web/app/page.tsx` + `apps/web/components/landing/*` |

`tokens.css` is imported unchanged so the design stays the single source of truth: re-import it
rather than hand-editing colours here.

### The design language, in short

- **Neutral near-black**, not a branded dark theme: `--bg #0A0A0A`, surfaces `#121212` / `#1B1B1B`,
  hairline borders `#232323`. Green (`--accent #3DD68C`) is reserved for yield, positive status and
  charts — it is never a button fill.
- **Buttons and chips are pills** (`--radius-control: 999px`). The primary button is a *neutral*
  pill — white fill, near-black text — so the accent stays meaningful. Secondary is a hairline pill.
  A non-clickable control goes grey rather than tinted.
- **Inter throughout**, medium (500) for every heading, with display tracking at `-0.02em`/`-0.03em`.
  Geist Mono is for hashes and raw data only — numerals use Inter with `tabular-nums`, set globally
  so digits never shift width as values tick.
- **Radii** step 8 (input) → 12 (card) → 16 (hero), and `--shadow` is used only on floating cards.

### Implementation notes

- The canvas is a Claude Design `.dc.html`: a custom DSL (`<x-dc>`, `<sc-if>`, `<sc-for>`,
  `{{ }}` bindings, a `DCLogic` class). It is a design document, not shippable React, so the page is
  a faithful re-implementation rather than a copy. The animation timings are carried over exactly —
  the hero settlement loop is 9s with beats at 0.9/1.7/2.5s (checks), 3.2–6.0s (flows) and 6.2s
  (receipt); the coupon loop is 14s (8s countdown, 5s paid, 1s reset).
- Hover states move from the canvas's `style-hover` attribute into utility classes in `globals.css`,
  since inline styles cannot express `:hover`.
- Fonts move from a runtime Google Fonts `<link>` to `next/font`, so they are self-hosted at build
  time — no render-blocking third-party request and no flash of fallback text. Verified: zero
  `fonts.googleapis.com` references in the served HTML.
- `prefers-reduced-motion` is honoured both in CSS and in the hooks: the reveal, count-up and both
  loops resolve to their finished state rather than animating.

## Two deliberate departures from the canvas

Both exist because SPEC §9.3 requires the landing page's live figures to be **real reads, with a
failed read rendering `—`, never a placeholder number** — and a marketing page is the worst place to
break that rule.

1. **Live stats are read from the chain, not sampled.** The canvas animates a count-up over
   illustrative figures (`1,248,500 USDC` settled, 44 holders). The implementation reads the diamond
   and renders `—` for anything it cannot read, so nothing is claimed before the contracts are
   deployed. The count-up itself is kept and drives the real values once they exist.
2. **The contracts strip lists the real cut.** The canvas named plausible placeholders
   (`MarketFacet`, `OwnershipFacet`, …). The implementation lists the ten facets `DeployTenor`
   actually cuts and reads their addresses from `DiamondLoupe.facets()`, showing `—` until deployed.
   A fabricated contract address under the heading "Built in the open" would be self-defeating.

The compliance toggle demo *is* interactive illustration and stays that way — but its three labels
(`Verification required`, `Account frozen`, `Trading paused`) are the exact strings
`apps/web/lib/errors.ts` produces for the real `InvalidKycStatus`, frozen-account and `IsPaused`
reverts. The demo shows what the app genuinely does, not a dramatisation of it.

## Still to implement

`Tenor v2.dc.html` (the app shell: Market, Holdings, Coupons, Contracts, the setup card and the
activity tray) and `Tenor Components.dc.html` (the component sheet). The app routes are stubbed at
`/market`, `/holdings`, `/coupons`, `/contracts`.
