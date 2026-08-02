# Project rules — pharmacy-platform rebuild

This file is authoritative project instruction for anyone (human or agent) working in this
repository. See `README.md` for the architecture overview and `docs/system-analysis/` for the
evidence-based analysis and blueprint this rebuild implements.

## GitHub

Repo: https://github.com/jerryboganda/maqsoodpharmacysoftware (remote `origin`, branch `master`).

## Hard rule: heavy compute runs in GitHub Actions, not on the laptop

**This is a hard, standing project rule, not a suggestion.** Wherever a GitHub Actions workflow
can do the work, it must — do not run the equivalent heavy task on the local dev machine instead.

Concretely, "heavy compute" means:
- Full dependency installs (`pnpm install`) done to *verify* the lockfile, not just to keep local
  `node_modules` usable for editing/dev-server work.
- `typecheck` / `build` / `test` across the whole monorepo (`turbo run ...`).
- Applying/verifying DB migrations end-to-end against a real MySQL instance.
- Anything else that's slow, whole-repo, and exists to confirm correctness rather than to let a
  person interact with a running app.

All of the above is wired into [`.github/workflows/ci.yml`](.github/workflows/ci.yml), which runs
on every push and pull request, including a real ephemeral MySQL 8.4 service container for the
migration step. **Before reaching for a local `pnpm turbo run build/test/typecheck` or a local
migration run to "make sure it's clean," push the branch (or open a PR) and let CI verify it.**
Use `gh run list` / `gh run watch` / `gh run view --log-failed` to check results instead of
re-running the equivalent work locally.

What's still fine to run locally (this rule is not "never touch the terminal"):
- The interactive dev loop (`pnpm dev`, hitting an endpoint with curl, looking at a page in a
  browser) — GitHub Actions can't replace live local development.
- A single targeted command while actively debugging one file (e.g. `tsc --noEmit` on one
  package you just edited, one `vitest` file). The whole-repo, "is everything green" pass belongs
  in CI.
- One-off, non-repeatable operations against the local dev database (schema exploration, manual
  data checks) that have no CI equivalent.

If a genuinely heavy task has no workflow yet, add one (or extend `ci.yml`) rather than running it
locally "just this once" — this keeps the rule true going forward instead of eroding one exception
at a time.

## Money and quantities

Never plain JavaScript numbers, anywhere. See `packages/money/src/Money.ts` and README.
