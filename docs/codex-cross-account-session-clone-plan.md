# Codex Cross-Account Session Clone Decision

Status: decision-complete, ready for implementation.

## Problem

Codex can resume a thread only when the target `CODEX_HOME` can see that
thread's rollout file. We verified this with a native Codex CLI session:

- Source native thread: `019e1330-52de-75a1-9a41-2875b5457d29`
- Source rollout exists under `/root/.codex/sessions/...`
- Importing with `Source account` works.
- Importing the same thread with another managed account fails with:
  `no rollout found for thread id 019e1330-52de-75a1-9a41-2875b5457d29`

This is not an auth routing bug. The selected target account launches Codex
with a different `CODEX_HOME`, and that home does not contain the source
thread rollout.

## Decision

Paseo will support Codex cross-account conversation continuity by cloning the
Codex rollout file from the source provider home into the selected target
provider home before strict resume.

This applies when all conditions are true:

- Provider is `codex`.
- Session behavior is `continue`.
- A native thread handle exists.
- Source provider home and target provider home differ.
- Source rollout file exists and can be read.
- Target account/home was explicitly selected by the user.

Paseo will not copy provider auth files, config files, token files, logs, or
global history. Only the per-thread rollout JSONL file and required parent
directories are cloned.

## Scope

In scope:

- Import session with a different selected Codex account.
- Existing/persisted Codex agent resume when the selected account differs and
  session behavior is `continue`.
- Existing active Codex agent account/profile switch when session behavior is
  `continue`.
- Server-side clone metadata for audit/debugging.
- Web/mobile UI copy that makes the cross-account session copy explicit.
- CLI import with `--account` as the explicit target account selection.

Out of scope:

- Claude and OpenCode native session cloning.
- Copying auth, config, provider caches, or global history.
- Summary/context carryover as the primary solution.
- Silent fresh-session fallback after clone failure.
- Cross-account clone without user-visible disclosure.

## Product Behavior

### Same Source Account

If the user imports with `Source account`, Paseo resumes from the source
provider home. No clone happens.

### Different Account

If the user imports a Codex session and selects a different account chip, Paseo
shows explicit copy wording and then clones the rollout into the selected
account home before resume.

Expected user result:

- Same Paseo agent.
- Same native Codex thread id.
- Same conversation context.
- New selected account credentials for future turns.

### Clone Failure

If clone fails, import fails with a clear error. Paseo does not silently start a
fresh thread.

Error copy:

`This Codex session could not be copied to the selected account. Continue with
Source account or choose Start fresh.`

## UI Decisions

### Import Session Sheet

When the selected account differs from `Source account`, show an inline notice
above the import list:

`This will copy the selected Codex session into the chosen account before
opening it. Auth files stay separate.`

The import CTA remains a single action. Its accessible label should include
`copy session and import` for the cross-account state.

### Account Chips

Labels stay unchanged:

- `Source account`
- `Default account`
- saved account labels/emails

Do not introduce "clone", "rollout", or `CODEX_HOME` terms into chip labels.

### CLI Import

`paseo agent import --account <key>` is explicit enough to select the target
account. No extra clone flag or setting is required.

```bash
paseo agent import codex <thread-id> --account <key>
```

If the selected account differs from the source home, the CLI performs the same
Codex rollout clone before resume and prints a concise status line:

`Copying Codex session to selected account...`

### Settings Surface

No global setting, runtime-profile setting, or provider-account setting is
added for this feature. Selecting a different account is the user intent. Paseo
does the required copy/resume work automatically.

## Backend Decisions

### Central Hook

Add one central prepare step before provider resume:

- `AgentManager.resumeAgentFromPersistence`
- `AgentManager.reloadAgentSession` via the existing resume path

The hook runs after launch resolution, because only then Paseo knows the final
target provider home/account.

### Provider Interface

Add an optional provider capability to `AgentClient`:

```ts
preparePersistedSessionForResume?(input: {
  handle: AgentPersistenceHandle;
  config: AgentSessionConfig;
  launchContext: AgentLaunchContext;
  sourceProviderHomeRef?: ProviderHomeRef | null;
  sourceLaunchContext?: AgentLaunchContext;
  reason: "import" | "reload";
}): Promise<AgentPersistenceHandle>;
```

Providers that do not implement it keep current behavior.

### Source Home Resolution

The source home is resolved server-side only:

- From `handle.metadata.providerHomeRef` or descriptor source metadata.
- Native default Codex source resolves to the effective default Codex home.
- Managed source resolves through `ProviderAuthService.resolveLaunchContext`.

Home paths are not added to client-visible protocol payloads.

### Target Home Resolution

The target home comes from the resolved launch:

- Managed target: `launchContext.env.CODEX_HOME`
- Native default target: effective Codex default home

If source and target home paths normalize to the same path, the prepare step is
a no-op.

## Codex Clone Algorithm

1. Read thread id from `handle.nativeHandle ?? handle.sessionId`.
2. Resolve source Codex home and target Codex home.
3. If homes are equal, return the original handle.
4. Locate source rollout under:

   `sourceHome/sessions/YYYY/MM/DD/rollout-*<threadId>.jsonl`

5. Validate the source path is inside `sourceHome/sessions`.
6. Compute the same relative path under `targetHome/sessions`.
7. If target file exists:
   - If content hash matches source, return original handle.
   - If content differs, fail and do not overwrite.
8. Create target parent directories.
9. Copy to a temp file in the target directory.
10. Atomically rename temp file to the final target path.
11. Preserve normal file mode where possible.
12. Return a handle whose metadata includes clone audit data.

No JSONL content is rewritten. The `session_meta.id` and thread id remain the
same.

## Clone Metadata

Write clone metadata only to server-side persisted handle metadata:

```ts
{
  codexSessionClone: {
    kind: ("rollout-file-copy",
      sourceProviderHomeRef,
      targetProviderHomeRef,
      threadId,
      sourceRelativePath,
      targetRelativePath,
      sourceSha256,
      targetSha256,
      clonedAt);
  }
}
```

Do not expose home paths or token paths in app-visible payloads.

## Security Rules

- Never copy `auth.json`, `config.toml`, token files, caches, logs, or
  provider-global history.
- Never overwrite a divergent target rollout. If one rollout is a strict prefix
  of the other, sync only by appending the missing JSONL suffix.
- Never follow symlinks outside source or target home.
- Never clone for unsupported providers.
- Never clone without explicit cross-account user action.
- Never fallback to a fresh thread silently.

## Files To Change

Backend:

- `packages/server/src/server/agent/agent-sdk-types.ts`
- `packages/server/src/server/agent/agent-manager.ts`
- `packages/server/src/server/agent/providers/codex-app-server-agent.ts`
- `packages/server/src/server/agent/provider-home-ref.ts`
- `packages/server/src/server/session.ts`
- `packages/server/src/client/daemon-client.ts`
- `packages/server/src/shared/messages.ts`

App:

- `packages/app/src/screens/workspace/workspace-import-sheet.tsx`

CLI:

- `packages/cli/src/commands/agent/import.ts`

Tests:

- `packages/server/src/server/agent/agent-manager.test.ts`
- `packages/server/src/server/agent/providers/codex-app-server-agent` targeted
  test file or a new adjacent unit test for clone helpers
- `packages/server/src/server/session.test.ts`
- `packages/app/src/screens/workspace/workspace-import-sheet.test.tsx`
- CLI import targeted test if existing command tests cover import flags

## Implementation Plan

1. Add the optional provider prepare capability and central AgentManager hook.
2. Add Codex rollout clone helper with path validation, hashing, and atomic
   copy.
3. Resolve source/target launch contexts in AgentManager before resume.
4. Wire Codex `preparePersistedSessionForResume` into import and reload resume
   paths.
5. Add app inline notice and CTA accessibility copy for cross-account import.
6. Keep CLI import automatic when `--account` selects a different Codex home.
7. Add targeted unit tests.
8. Run targeted tests, `npm run format`, `npm run lint`, and
   `npm run typecheck`.

## Acceptance Criteria

- Source account import still works without clone.
- Native default Codex import still remembers the marker.
- Managed source account import still routes to source profile.
- Native source to different managed target clones rollout and remembers the
  marker.
- Managed source to different managed target clones rollout and remembers the
  marker.
- Target account is the active account for the next turn after import.
- Missing source rollout produces a clear import error.
- Existing older target rollout fast-forwards by appending the missing JSONL
  suffix.
- Existing divergent target rollout is not overwritten.
- Unsupported providers do not clone.
- CLI cross-account import clones automatically when `--account` selects a
  different Codex home.
- No auth/config/token files are copied.

## Manual Test Matrix

Use markers so the result is unambiguous:

- `SOURCE_NATIVE_CLONE_001`
- `SOURCE_MANAGED_CLONE_002`
- `ACTIVE_SWITCH_CLONE_003`

For each successful clone test:

1. Create Codex CLI/native or managed source session with the marker.
2. Import/switch using a different selected account.
3. Ask: `Which marker is in this conversation? Reply with only the marker.`
4. Confirm the marker is returned.
5. Confirm the persisted agent config has target `providerHomeRef`.
6. Confirm clone metadata is present server-side.

## Merge Gate

Do not merge if Codex cannot resume from the cloned rollout in manual testing.
If clone succeeds but target account fails due to quota, classify the test as
account/quota failure only after logs prove the cloned rollout exists in the
target home and Codex reached provider execution.
