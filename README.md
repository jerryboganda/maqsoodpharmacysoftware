# Pharmacy platform — modernization rebuild

Node.js/TypeScript + React/TypeScript + MySQL rebuild of WASEELA ABUZAR V3, the PowerBuilder
pharmacy system this project replaces. Every architectural decision here traces back to a
specific, evidence-based finding — nothing in this repository is invented.

## Before touching this code, read the analysis

The complete, evidence-based analysis of the legacy system and the binding architecture
blueprint both live in `../docs/system-analysis/`. In particular:

- `00b-owner-decisions-and-requirements.md` — binding owner decisions (D1–D21) and
  project-wide design principles (P1). These override anything inferred from code.
- `17-technical-blueprint.md` — the binding stack decisions this repo implements
  (NestJS 11 on Fastify, Drizzle ORM over `mysql2`, Vite + React Router 7 + TanStack Query,
  the money/decimal precision rules, transaction/concurrency/idempotency design).
- `19-mysql-schema-blueprint.md` — the target database schema this repo's `packages/db`
  implements.
- `12-risks-gaps.md` and `14-unknowns-and-questions.md` — known risks and open questions.
  Several remaining items require a licensed accountant/tax adviser/pharmacist — see
  `23-accountant-tax-adviser-handoff.md`.

## Repository layout

See `17-technical-blueprint.md` §3.1 for the full rationale. Summary:

- `apps/api` — the backend, a NestJS modular monolith.
- `apps/web` — the frontend, a Vite + React client.
- `packages/money` — `Money`/`Quantity`/`Percent` value objects. The **only** place
  arithmetic on money or quantities is permitted anywhere in this codebase.
- `packages/db` — Drizzle ORM schema, migrations, and seeds.
- `packages/contracts` — Zod schemas shared between API and web (the API contract).
- `packages/config` — shared TypeScript/lint/test configuration.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

## The one rule that matters most

Money and quantities are never plain JavaScript numbers, anywhere — not in the database,
not in an API contract, not in a React component. See `packages/money/src/Money.ts` and
`17-technical-blueprint.md` §6 for why: the legacy system's ~1 million ledger rows are
`DECIMAL`, and the target has a paisa-exact reconciliation requirement against them.
