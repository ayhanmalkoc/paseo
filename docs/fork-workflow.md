# Fork Workflow

This document is the fork workflow guide for developers who work from a fork and
periodically synchronize with the upstream Paseo repository. It defines how to
keep `main` clean, how to use a fork-local `dev` branch, how to prepare focused
contribution branches, and how to record validation evidence.

If a fork keeps extra local process notes, screenshots, or environment-specific
files, keep those changes out of upstream pull-request branches unless a
maintainer explicitly asks for them.

## Remote Model

Use these remote names:

- `upstream`: the source repository, usually `getpaseo/paseo`.
- `origin`: your fork.

The expected long-lived branches are:

- `upstream/main`: upstream source of truth.
- `origin/main`: fork mirror of `upstream/main`.
- `dev`: fork integration and verification branch.
- `test`: fork runtime validation branch. Keep it synchronized from `dev`, then
  merge the feature or cleanup branch being tested.

## Branch Roles

- `main` mirrors upstream. Do not use it as a workspace branch.
- `dev` is where fork-local integration happens.
- `fix/*` is for focused bug fixes.
- `feature/*` is for focused feature work.
- `cleanup/*` is for scoped cleanup or technical-debt work.
- `docs/*` is for documentation-only work when a separate branch is useful.

Contribution branches should contain only the code, tests, and docs needed for
that contribution. Do not include `.out/`, screenshots, fork-only notes, local
environment files, or unrelated cleanup.

## Keep Main Synchronized

Before creating new work, or when upstream may have moved, synchronize the fork
main:

```bash
git fetch --all --prune
git switch main
git merge --ff-only upstream/main
git push origin main
```

Expected state after sync:

```bash
git rev-list --left-right --count origin/main...upstream/main
# 0 0
```

If `origin/main` cannot fast-forward cleanly, stop and inspect. Do not create a
merge commit on `main` to resolve fork drift.

## Use Dev For Fork Integration

Use `dev` to combine accepted work and test the fork as a whole:

- Merge completed or in-progress contribution branches into `dev` for combined
  validation.
- Push `dev` after each accepted integration step.
- Keep fork-local workflow notes on `dev`, not on upstream PR branches.
- Merge updated `main` into `dev` when the integration branch needs new upstream
  changes.

Typical `dev` sync:

```bash
git switch dev
git merge main
git push origin dev
```

Typical branch integration:

```bash
git switch dev
git merge --no-ff <branch-name>
git push origin dev
```

## Use Test For Runtime Validation

Use `test` when a change needs hands-on validation in the development server
before it is accepted into `dev`:

- Rebase or reset `test` from current `dev` before starting a validation pass.
- Merge only the branch being tested into `test`.
- Run the development daemon and web app from `test`.
- If validation passes and the work is accepted, merge the original feature or
  cleanup branch into `dev`; do not treat `test` as the source of truth.

Local helper:

```bash
./scripts/dev-test.sh daemon
./scripts/dev-test.sh web
```

## Contribution Branch Flow

For upstreamable work:

1. Start from synchronized `main`, unless continuing an existing PR branch.
2. Create a focused branch such as `fix/name`, `feature/name`, or `cleanup/name`.
3. Commit only the relevant implementation, tests, and documentation.
4. Push the branch to the fork.
5. Open or update a pull request against `getpaseo/paseo:main`.
6. Add validation notes, logs, and UI evidence to the PR when relevant.
7. Merge the same branch into `dev` for fork integration testing when the fork
   needs to run that work before upstream accepts it.

For fork-only work:

1. Start from `dev`.
2. Create a focused branch when the change is more than a trivial edit.
3. Merge back into `dev` after review or local validation.
4. Push both the branch and `dev` when the branch should remain visible.

## Evidence And Artifacts

- Use `.out/` for local screenshots, temporary reports, and PR evidence files.
- `.out/` must not be committed.
- If a PR needs UI evidence, attach it through a PR comment using hosted image
  URLs or another explicit evidence path.
- Summaries should include concrete validation commands and relevant log checks.

## Validation Expectations

Use the repo rules in `CLAUDE.md`:

- Prefer targeted tests over broad suites.
- Run repo npm scripts, not raw tool binaries.
- Run `npm run format` or targeted `npm run format:files -- <files>` before
  committing.
- For code changes, run targeted tests, lint, and typecheck as appropriate.
- If a broad hook fails from unrelated existing `dev` state, report the exact
  failure and keep the commit scope narrow.

## Quick Status Checklist

Use this before claiming branches are synchronized:

```bash
git fetch --all --prune
git status --short --branch
git rev-list --left-right --count origin/main...upstream/main
git rev-list --left-right --count dev...origin/dev
git rev-list --left-right --count <branch-name>...origin/<branch-name>
git merge-base --is-ancestor origin/<branch-name> origin/dev
```

Expected meaning:

- `origin/main...upstream/main` is `0 0`: fork main is synchronized with
  upstream.
- `dev...origin/dev` is `0 0`: local and remote `dev` are synchronized.
- `<branch>...origin/<branch>` is `0 0`: local and remote branch are
  synchronized.
- `merge-base --is-ancestor` exits `0`: the branch is included in `dev`.

## Suggested Codex Instruction

When using Codex on this repo, add this instruction:

```text
Follow docs/fork-workflow.md for upstream/main, fork/main, dev, contribution
branch, PR, evidence, and validation workflow. Keep fork-local workflow files and
artifacts off upstream PR branches unless maintainers explicitly ask for them.
```
