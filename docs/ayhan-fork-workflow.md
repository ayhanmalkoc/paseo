# Ayhan Fork Workflow

This document records the working rules for the `ayhanmalkoc/paseo` fork. It is
intended to live on the fork `dev` branch only. Do not copy it into upstream PR
branches unless explicitly requested.

## Branch Roles

- `upstream/main` is the source of truth for the project.
- `origin/main` must stay clean and synchronized with `upstream/main`.
- `main` is not a workspace branch. Do not commit local notes, artifacts,
  workflows, screenshots, or fork-only process files there.
- `dev` is the fork integration and verification branch.
- `fix/*` branches are contribution branches used for upstream PRs.

## Main Sync Rule

Before creating new work or when upstream may have moved, check and sync:

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
merge commit on `main` just to resolve fork drift.

## Dev Branch Rule

`dev` is where fork-local integration happens:

- Merge completed or in-progress `fix/*` branches into `dev` for real combined
  validation.
- Push `dev` after each accepted integration step.
- Keep fork-local docs, ignore rules, and local workflow notes on `dev`, not on
  upstream PR branches.
- Periodically merge updated `main` into `dev` when the integration branch needs
  to include new upstream changes.

Typical sync:

```bash
git switch dev
git merge main
git push origin dev
```

## Fix Branch Rule

For upstream contributions:

1. Start from synchronized `main` unless continuing an existing PR branch.
2. Create a focused `fix/*` branch.
3. Commit only the code and tests needed for that upstream PR.
4. Push the branch to `origin/fix/...`.
5. Open or update the upstream PR against `getpaseo/paseo:main`.
6. Add validation notes, logs, and UI evidence to the PR as comments.
7. Merge the same fix branch into `dev` for fork integration testing.

Fix branches must stay clean: do not include `.out/`, screenshots, fork-only
workflow documents, or unrelated local setup changes.

## Evidence And Artifacts

- Use `.out/` for local screenshots, temporary reports, and PR evidence files.
- `.out/` is ignored on `dev` and must not be committed to fix branches.
- If a PR needs UI evidence, attach it through a PR comment using hosted image
  URLs or another explicit evidence path.
- Summaries should include concrete validation commands and relevant log checks.

## Validation Expectations

Use the repo rules in `CLAUDE.md`:

- Prefer targeted tests over broad suites.
- Run repo npm scripts, not raw tool binaries.
- For code changes, run targeted `lint`, `format:check`, relevant tests, and
  typecheck as appropriate.
- If a broad hook fails from unrelated existing `dev` state, report the exact
  failure and keep the commit scope narrow.

## Quick Status Checklist

Use this before claiming branches are synchronized:

```bash
git fetch --all --prune
git status --short --branch
git rev-list --left-right --count origin/main...upstream/main
git rev-list --left-right --count dev...origin/dev
git rev-list --left-right --count fix/<branch>...origin/fix/<branch>
git merge-base --is-ancestor origin/fix/<branch> origin/dev
```

Expected meaning:

- `origin/main...upstream/main` is `0 0`: fork main is synced with upstream.
- `dev...origin/dev` is `0 0`: local and remote dev are synced.
- `fix...origin/fix` is `0 0`: local and remote fix branch are synced.
- `merge-base --is-ancestor` exits `0`: the fix branch is included in dev.

## Suggested Codex Instruction

When using Codex on this repo, add this personal instruction:

```text
When working in C:\dev\paseo, follow docs/ayhan-fork-workflow.md for the
upstream/main, fork/main, dev, fix branch, PR, evidence, and validation workflow.
Keep fork-local workflow files and artifacts off upstream PR branches.
```
