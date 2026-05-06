# Provider Auth Profiles Plan

Status: Codex MVP implemented on `codex/provider-auth-profiles`
Branch: `codex/provider-auth-profiles`
Reference: [Loongphy/codex-auth](https://github.com/Loongphy/codex-auth), inspected at `d3102f0`

## Implementation Status

The Codex MVP is implemented behind a provider-neutral auth profile service:

- server-side storage, sanitized RPC schemas, and Codex `auth.json` parsing are
  in place;
- Codex launches receive an isolated `CODEX_HOME` through `AgentLaunchContext`;
- new and persisted agents carry `authProfileKey` without breaking older
  clients;
- provider settings expose account import/default/refresh/remove actions;
- composer Preferences expose a separate Account row while leaving
  provider/model selection unchanged;
- local Codex rollout usage scanning and default/auto-ready selection are
  implemented server-side.

Future provider support still requires provider-specific adapters for Claude,
OpenCode, Pi, or custom providers; the app/RPC contract is intended to remain
unchanged for those additions.

## Next Scope: Automatic Current Auth Sync

This is the next implementation scope. It is intentionally narrower than full
account rotation.

Goal:

- keep Paseo's provider-auth registry synchronized with the provider's current
  global login state;
- remove the need to manually press "Import current" after each external
  provider login or account switch;
- preserve explicit/default account selection semantics for new agents;
- never move an existing or running agent to a different account silently.

Non-goals:

- do not implement provider login inside Paseo;
- do not rewrite the user's global provider auth file;
- do not add automatic account rotation based on usage in this step;
- do not add Claude/OpenCode/Pi adapters in this step.

### Automatic Sync Decisions

1. Sync means idempotent import/update of the current global auth profile.

   For Codex, the adapter reads the effective global Codex home
   (`CODEX_HOME` or the default `.codex` home), parses `auth.json`, computes
   the stable profile key, and updates the matching Paseo-managed isolated
   profile. If the key is new, it creates a new profile. If the key already
   exists, it refreshes the stored profile snapshot and public metadata.

2. Sync must not override user intent.

   A global account switch should make the new account visible in Paseo, but it
   must not silently change an explicit draft selection, persisted provider
   preference, running agent, or stored agent resume key.

3. First-profile defaulting is allowed.

   If a provider has no default profile and sync creates the first ready
   profile, it may become the default. If a default already exists, sync should
   leave it unchanged.

4. Sync should be lazy first, watcher second.

   The first implementation should run sync at deterministic app/server
   interaction points. A file watcher can be added after the behavior is stable,
   but the feature should not depend on watcher reliability across Windows,
   macOS, Linux, WSL, and networked home directories.

5. Sync is provider-adapter capability, not Codex-specific service logic.

   The daemon service should expose provider-neutral methods such as
   `syncCurrentProfile(provider)` and let adapters declare whether they support
   current-auth sync. Codex supplies the first adapter implementation.

### Automatic Sync Trigger Plan

Initial triggers:

- daemon bootstrap: best-effort sync for providers with current-auth sync
  support;
- `list_provider_auth_profiles_request`: sync the requested provider before
  returning profiles, unless the caller explicitly requests cached-only data in
  a future optional field;
- provider diagnostic refresh: sync before showing the Accounts section;
- new agent create path: sync the selected provider before resolving default
  auth selection, so a recent external login is available immediately.

Deferred trigger:

- debounced file watcher for known auth files such as Codex `auth.json`.
  Watchers should be an optimization only; RPC/create-path sync remains the
  correctness path.

### Automatic Sync Server Plan

Add or refactor in `ProviderAuthService`:

- `syncCurrentProfile(provider: AgentProvider, options?: SyncOptions)`:
  provider-neutral idempotent operation;
- `syncAllCurrentProfiles(options?: SyncOptions)`:
  bootstrap helper for adapters that support sync;
- shared write/update path with existing `importProfile({ source: "current" })`
  to avoid duplicate persistence semantics;
- metadata result indicating whether the profile was `created`, `updated`,
  `unchanged`, `unsupported`, `missing-auth`, or `failed`;
- optional `setDefaultWhenEmpty` behavior, defaulting to true for first-profile
  sync and false for existing-default cases.

Expected service behavior:

- if the provider has no adapter or no sync capability, return an unsupported
  result without throwing for list/bootstrap paths;
- if the current auth file is missing, return a missing-auth result and keep
  existing stored profiles;
- if parsing fails, keep existing stored profiles and surface a clear warning or
  RPC error depending on trigger;
- if sync succeeds, invalidate/update the same provider-auth registry used by
  manual import.

### Automatic Sync Codex Adapter Plan

Reuse the existing Codex import implementation:

- resolve the effective Codex home from `CODEX_HOME` or default user `.codex`;
- read and parse `auth.json`;
- compute the stable key from API key, ChatGPT account/user claims, or unknown
  auth hash;
- copy `auth.json` and optional `config.toml` into the matching isolated
  profile `codex-home`;
- refresh sanitized metadata: alias, email, account id, user id, auth mode,
  plan, status, last refresh, local usage snapshot;
- preserve user-facing alias if the user renamed it later, unless no alias
  exists.

### Automatic Sync App Plan

Keep the UI simple:

- Provider Accounts section should show automatically synced profiles without
  requiring the user to press "Import current";
- keep "Import current" as a manual recovery/force-refresh action;
- show a small sync/loading state while profile list sync is running;
- show clear empty text when the provider supports auth profiles but no global
  login exists;
- in Preferences, the Account row should use synced profiles and continue to
  show default/explicit selection exactly as today.

No new primary UI surface is required for this scope.

### Automatic Sync Compatibility Plan

RPC schema changes must be additive:

- existing `list_provider_auth_profiles_request` can keep working unchanged;
- optional fields may be added later, for example `sync?: boolean` or
  `cachedOnly?: boolean`;
- responses may add optional sync metadata, but clients must not depend on it
  for basic profile display;
- old clients should continue listing existing stored profiles without knowing
  about sync metadata.

### Automatic Sync Tests

Server targeted tests:

- syncing current Codex auth creates a new profile when registry is empty;
- syncing the same current auth updates the existing profile without duplicate
  keys;
- syncing a different current auth adds a second profile without changing the
  existing default;
- first synced profile becomes default only when no default exists;
- missing `auth.json` does not delete existing profiles;
- parse failure does not corrupt registry data;
- create-agent default resolution sees a newly synced current profile before
  launch;
- explicit `authProfileKey` still wins over synced/default profile;
- resume keeps the persisted `authProfileKey`.

App targeted tests:

- profile-list hook invalidates/refetches after sync/list operations;
- Accounts section displays automatically synced profiles;
- Preferences Account row preserves explicit selection after the provider list
  refreshes.

### Automatic Sync Validation

Follow the repo validation rules:

- run targeted provider-auth service and Codex adapter tests;
- run targeted agent-manager tests for launch selection;
- run targeted app hook/component tests if app code changes;
- run `npm run format:files -- <changed files>`;
- run `npm run lint -- <changed files>`;
- run `npm run typecheck`;
- live validation: switch global Codex account externally, open Paseo Accounts,
  confirm the profile appears without pressing "Import current", then start a
  new Codex agent and verify its launch metadata/profile key.

### Automatic Sync Definition of Done

- A user can switch/login Codex externally and see the active account appear in
  Paseo without manual import.
- Re-syncing the same external account updates the existing profile instead of
  creating duplicates.
- A new external account is added as a new ready profile.
- Existing default and explicit selections remain stable.
- New agent creation can use the newly synced account.
- Existing/running/resumed agents stay pinned to their original auth profile.
- Missing or invalid global Codex auth does not delete or corrupt stored
  profiles.
- No provider secrets are sent to the app or written to logs.

## Goal

Add native multi-account auth profile support to Paseo so users can run agents
against different provider accounts from the app. Codex is the first supported
provider, but the architecture must support Claude, OpenCode, Pi, and custom
providers later without recoding the feature around Codex-specific state.

The user-facing outcome is:

- import or register multiple provider accounts on a host;
- select the account used for a new agent;
- keep existing agents pinned to the account they were created or resumed with;
- show safe account metadata and usage state in the UI;
- optionally auto-select a better account for new work when usage is low.

## Reference Findings

`codex-auth` is a useful behavioral reference, but it should not become a
runtime dependency for Paseo.

Relevant behaviors from `codex-auth`:

- It resolves the Codex state root from `CODEX_HOME`, then the platform home
  `.codex` directory.
- It stores a `registry.json` plus per-account `auth.json` snapshots.
- It parses Codex `auth.json` and decodes the `id_token` to derive email,
  ChatGPT account id, ChatGPT user id, plan, auth mode, and a stable account
  key.
- It switches the active account by rewriting the active Codex `auth.json`.
- It can scan Codex rollout/session logs for local rate-limit usage.
- It has optional API-backed usage and team-name refreshes.
- Its auto-switch model is background-worker oriented and experimental.

Paseo should keep the account parsing/storage ideas, but use a safer launch
model that fits Paseo's agent lifecycle.

## Core Decisions

1. Implement a native provider-auth layer in the Paseo daemon.

   Do not shell out to `codex-auth` for normal runtime behavior. External CLI
   integration would add version drift, install state, stdout parsing, and
   process orchestration risk. `codex-auth` remains a reference and optional
   import compatibility target.

2. Use provider-specific adapters behind a provider-neutral interface.

   Codex needs `CODEX_HOME` and `auth.json` handling. Claude or OpenCode may
   need different files, env vars, or login flows. The daemon should expose one
   common auth-profile service and let adapters own provider-specific details.

3. Prefer isolated provider homes over rewriting the user's global auth.

   For the Codex MVP, each saved account should have an isolated Codex home.
   Launching a Codex app-server for that account means passing
   `CODEX_HOME=<profileHome>` through `AgentLaunchContext.env`.

   This avoids global side effects, supports concurrent agents under different
   accounts, and matches Paseo's process-per-agent model. A later explicit
   action can still offer "make this the system Codex account" if users want
   classic `codex-auth switch` behavior.

4. Pin running and persisted agents to their selected auth profile.

   Account auto-selection can choose defaults for new sessions, but it must not
   silently move an existing agent to a different account. Resume must use the
   original `authProfileKey`.

5. Never send secrets to the mobile/web client.

   WebSocket messages may include aliases, email, provider, plan, status, usage
   percentages, and timestamps. They must not include access tokens, refresh
   tokens, raw `auth.json`, API keys, or full JWT payloads.

## Proposed Domain Model

```ts
type ProviderAuthProfile = {
  provider: AgentProvider;
  key: string;
  alias: string;
  email?: string;
  accountName?: string;
  accountId?: string;
  userId?: string;
  authMode: "chatgpt" | "api-key" | "unknown";
  plan?: string;
  status: "ready" | "needs-login" | "invalid" | "refreshing";
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  usage?: ProviderAuthUsageSnapshot;
};

type ProviderAuthUsageSnapshot = {
  source: "local-rollout" | "provider-api";
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  creditsRemaining?: number;
  refreshedAt: string;
};

type ProviderAuthSelection = {
  provider: AgentProvider;
  profileKey?: string;
  strategy: "explicit" | "default" | "auto";
};
```

The internal stored record can contain provider-specific metadata and file
paths. The RPC shape should stay sanitized and backward-compatible.

## Storage Layout

Use Paseo-owned host storage, not direct mutation of the user's global provider
home.

```text
$PASEO_HOME/
  provider-auth/
    registry.json
    codex/
      profiles/
        <profileKey>/
          codex-home/
            auth.json
            config.toml
            AGENTS.md or instructions overlays, if needed later
          profile.json
```

Storage rules:

- `registry.json` contains schema version, provider ids, defaults,
  auto-selection config, and sanitized profile metadata.
- Provider homes contain sensitive provider files and are never exposed through
  WebSocket RPCs.
- Writes are atomic. Import operations preserve a backup path or a rollback
  record before replacing a profile snapshot.
- On Unix, sensitive files should be hardened to private permissions. On
  Windows, use best-effort hidden/private storage and avoid permissive copies.
- Schema changes must be additive and migrate older records forward.

## Provider Auth Adapter

Add a server-side adapter interface similar to:

```ts
interface ProviderAuthAdapter {
  readonly provider: AgentProvider;
  readonly capabilities: ProviderAuthCapabilities;

  listProfiles(): Promise<ProviderAuthProfile[]>;
  importCurrentAuth(options?: ImportOptions): Promise<ProviderAuthProfile>;
  importAuthFile(path: string, options?: ImportOptions): Promise<ProviderAuthProfile>;
  removeProfile(profileKey: string): Promise<void>;
  setDefaultProfile(profileKey: string | null): Promise<void>;
  refreshProfile(profileKey: string, options?: RefreshOptions): Promise<ProviderAuthProfile>;
  resolveLaunchContext(selection: ProviderAuthSelection): Promise<ProviderAuthLaunchContext>;
}

type ProviderAuthLaunchContext = {
  profileKey: string | null;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
};
```

The daemon-level auth service coordinates adapters, persistence, and RPC
schemas. Adapters remain provider-specific.

## Codex MVP Behavior

The first implementation should support:

1. Import current Codex auth.

   Read the current effective `auth.json` from the user's default Codex home,
   parse it, copy it into a Paseo-managed isolated Codex home, and register the
   profile.

2. Import an auth file.

   Allow importing a single `auth.json` path. The UI can start with host-local
   path input or desktop file picker later.

3. Launch with the selected account.

   Before `AgentManager.createAgent`, resolve auth selection for the provider.
   For Codex, pass `CODEX_HOME=<profileHome>/codex-home` in
   `AgentLaunchContext.env`.

4. Resume with the same account.

   Store `authProfileKey` in `AgentSessionConfig.extra` and/or
   `AgentPersistenceHandle.metadata`. The resume path resolves the launch env
   from that pinned key.

5. Show local usage.

   Scan the selected isolated Codex home for rollout/session usage events. API
   refresh remains opt-in and can be deferred until the local path is stable.

6. Auto-select for new sessions only.

   If enabled, choose the best available profile using latest usage and
   freshness. Do not switch active app-server processes mid-run.

## Paseo Integration Points

Server:

- `packages/server/src/server/agent/provider-launch-config.ts`
  already supports env overlays. Auth profile env should feed into the same
  path instead of adding provider-specific process launch code.
- `packages/server/src/server/agent/agent-manager.ts`
  currently builds `AgentLaunchContext` with `PASEO_AGENT_ID`. It should merge
  provider auth launch context before `createSession`, `resumeSession`, and
  reload paths.
- `packages/server/src/server/agent/providers/codex-app-server-agent.ts`
  already spawns `codex app-server` and accepts `launchContext.env`. The Codex
  auth adapter should supply `CODEX_HOME` here.
- `packages/server/src/server/agent/agent-storage.ts`
  serializes selected config fields. Add optional, backward-compatible auth
  profile metadata without making older records invalid.
- `packages/server/src/server/agent/provider-registry.ts`
  should expose auth capabilities alongside provider definitions or through a
  sibling auth service.
- `packages/server/src/shared/messages.ts`
  needs additive RPC schemas and feature gating. Never make existing provider
  snapshot fields required or narrower.

App:

- `packages/app/src/screens/settings/providers-section.tsx`
  is the right entry point for provider account management. Provider detail
  should grow beyond diagnostics into a provider details sheet/screen with an
  Accounts section.
- `packages/app/src/components/agent-status-bar.tsx`
  and composer preferences should show an Account row only when the selected
  provider supports auth profiles. The provider/model selector must stay focused
  on provider/model selection.
- `packages/app/src/hooks/use-providers-snapshot.ts`
  can keep provider availability/model state. Auth profiles should use their own
  query key to avoid mixing sensitive or slower state into model snapshots.

## RPC and Compatibility Plan

Add a feature flag such as `providerAuthProfiles` to server info. Old clients
ignore it. New clients only call the new RPCs when present.

Proposed request/response families:

- `list_provider_auth_profiles_request`
- `import_provider_auth_profile_request`
- `remove_provider_auth_profile_request`
- `set_default_provider_auth_profile_request`
- `refresh_provider_auth_profile_request`
- `update_provider_auth_auto_select_request`
- optional `provider_auth_profiles_update`

Compatibility rules:

- all new fields are optional or defaulted;
- existing message schemas are not changed except additive optional fields;
- raw secrets never cross the protocol;
- errors should be ordinary RPC errors, not schema-breaking payloads.

## UI Plan

Provider Settings:

- The Providers list remains as it is today.
- Tapping a provider opens provider details.
- The details surface includes diagnostics plus an Accounts section when the
  provider supports auth profiles.
- Account rows show icon, alias, email/account name, plan, status, last used,
  and usage indicators.
- Actions: Import current auth, Import auth file, Set default, Rename, Remove,
  Refresh usage.

New Agent / Composer Preferences:

- Keep provider/model selection as the existing model selector.
- Add a separate Account row in Preferences when the selected provider has
  profiles.
- If there is one default account, show its alias/email with a compact change
  control.
- If auto-select is enabled, show "Auto" as the selected account and display
  the resolved profile only after creation.

Running Agent:

- Show selected account metadata in agent details or status, not in the compact
  chat bar by default. The chat bar should stay quiet unless the account is
  missing or invalid.

## Auto-Selection Rules

Initial MVP:

1. If an explicit profile key is selected, use it.
2. If auto-select is enabled, choose the ready profile with the best fresh usage
   score.
3. If no fresh usage exists, fall back to the provider default profile.
4. If no default exists, use the most recently imported ready profile.
5. If no profile exists, keep current provider behavior and surface a clear
   "no auth profile configured" affordance in settings.

Auto-selection should run before launching a new session. It should not rewrite
global auth and should not move already-running sessions.

## Known Risks

- Isolated `CODEX_HOME` may hide global Codex config, skills, custom prompts,
  or MCP settings that users expect. The MVP must either copy a safe baseline
  from the source Codex home during import or document which files are isolated.
- `codex-app-server-agent.ts` has helper paths that may read the daemon process
  `CODEX_HOME` or default home for prompts/skills. Those paths need to use the
  effective launch Codex home when an auth profile is selected.
- Codex model availability can be account-dependent. Provider model snapshots
  may need account-aware refresh after the first working auth-profile launch.
- API usage refresh touches provider services with user tokens. Keep it
  explicit opt-in and clearly labeled.
- Active session switching can corrupt expectations. Only future sessions
  should auto-switch unless a provider adapter later proves a safe live-switch
  operation.
- Windows file permission hardening is weaker than POSIX mode changes. Avoid
  exposing sensitive paths and keep copies under Paseo-owned app data.

## Implementation Phases

### Phase 0: Decision and issue

- Land this plan.
- Open or link a tracking issue with the decisions, risks, and MVP scope.

### Phase 1: Server storage and Codex parsing

- Add provider-auth storage service and schemas.
- Add Codex auth parser for `auth.json`, JWT payload metadata, API-key mode,
  and malformed/expired cases.
- Add targeted tests for parsing, storage migrations, and secret redaction.

### Phase 2: Launch context integration

- Add auth-profile selection to agent config/persistence metadata.
- Merge provider auth env into `AgentLaunchContext`.
- Pass isolated `CODEX_HOME` into Codex app-server launches.
- Add targeted `agent-manager` tests for create/resume/reload launch contexts.

### Phase 3: RPC and app settings UI

- Add additive WebSocket schemas and daemon handlers.
- Add app hooks for provider auth profiles.
- Extend provider settings details with Accounts.
- Add import/default/remove/refresh flows.

### Phase 4: Composer Preferences account selection

- Add a separate Account row to Preferences.
- Persist selected/default/auto account in draft form state.
- Ensure provider/model selector behavior remains unchanged.

### Phase 5: Usage and auto-select

- Implement local rollout usage scan first.
- Add opt-in API refresh only after local usage is stable.
- Add auto-select scoring and tests.

### Phase 6: Future providers

- Extract adapter tests into a provider-neutral contract.
- Add Claude/OpenCode/Pi support by implementing their adapters without
  changing the app RPC contract.

## Validation Plan

Targeted only, following repo rules:

- storage/parser unit tests for provider-auth records and Codex auth parsing;
- `agent-manager` tests for create/resume/reload env propagation;
- message schema tests for backward-compatible new RPCs;
- app hook/component tests for Accounts UI and Preferences Account row;
- `npm run format:files -- <changed files>`;
- `npm run lint -- <changed files>`;
- relevant package `npm run typecheck` after code changes;
- live validation later with user-provided accounts, without restarting the main
  daemon unless explicitly approved.

## Definition of Done

- A user can import two Codex accounts on one host.
- A new Codex agent can be started with either account from the UI.
- Two Codex agents can run concurrently with different accounts.
- Restart/resume keeps each agent on the same auth profile.
- The app shows sanitized profile metadata and usage state.
- Secrets are never sent to the client or logs.
- Existing clients and existing agents continue to work when no auth profiles
  are configured.
