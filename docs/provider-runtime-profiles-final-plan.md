# Provider Runtime Profiles Final Plan

Status: decision-complete final product plan; implementation not started
Branch: `codex/provider-auth-profiles`
Related docs:

- [provider-auth-profiles-plan.md](./provider-auth-profiles-plan.md)
- [provider-auth-onboarding-plan.md](./provider-auth-onboarding-plan.md)
- [provider-auth-onboarding-architecture-dossier.md](./provider-auth-onboarding-architecture-dossier.md)

## Decision Summary

Build the final provider profile product as one coherent layer, not as separate
half-features.

Final model:

```text
Provider Definition = provider capability and request behavior
Auth Account = credential record and isolated provider home
Runtime Profile = mutable template for how agents should run
Agent Snapshot = immutable launch-time copy of a runtime profile
Agent Session = running provider process, workspace, and timeline
```

The implementation should stay minimal: add only the services and UI needed to
make this model real, avoid a Hermes-style whole-instance profile, and keep
Paseo's existing daemon/provider/agent architecture intact.

## Current Paseo Architecture Fit

Paseo already has the right spine:

```text
App / CLI / Desktop
  -> WebSocket RPC
    -> session.ts
      -> AgentManager
        -> provider adapters
          -> Claude / Codex / OpenCode processes
```

This should not be replaced. The new product layer should resolve profile and
account choices before the `AgentManager` starts or restarts a provider session.
After resolution, `AgentManager` should receive a concrete launch snapshot, not
a live mutable profile reference.

## Reference Lessons

### From `codex-auth`

Keep:

- stable account keys from provider auth metadata;
- isolated auth snapshots;
- account usage/status awareness.

Do not keep:

- rewriting the user's global provider auth file as the normal runtime switch
  mechanism;
- making an external CLI a runtime dependency.

### From OpenAI Codex app-server

Keep:

- structured app-server device-code login for native onboarding;
- app-server JSON-RPC as the integration boundary when available.

### From Hermes Agent

Keep:

- provider behavior described declaratively;
- credentials stored in app-owned auth state, not provider global files;
- cross-process credential write coordination;
- credential pool concepts as a future-compatible design axis.

Do not keep:

- whole-instance profile isolation as the main Paseo profile model. Hermes
  profiles isolate all of `HERMES_HOME`: config, env, memory, sessions, skills,
  gateway, cron, logs. Paseo needs a smaller runtime-template model because one
  daemon manages many agents, workspaces, and providers concurrently.

## Product Goals

- Add accounts natively from Paseo, starting with Codex device-code login.
- Store provider accounts in Paseo-owned isolated storage.
- Create reusable runtime profiles that combine provider, account, model, MCP,
  skills, instructions, permissions, feature defaults, env overlays, and
  workspace defaults.
- Start new agents from runtime profiles.
- Keep running agents stable when a profile is edited.
- Let users explicitly restart an active agent with a different account or an
  updated profile.
- Support concurrent agents with predictable account/profile behavior.
- Keep WebSocket protocol backward-compatible.
- Keep secrets server-side.

## Non-Goals

- Do not replace Paseo's `AgentManager` or provider adapter architecture.
- Do not implement a Hermes-style full host/profile clone.
- Do not silently mutate running agents when a runtime profile changes.
- Do not silently rotate active agents across accounts because of quota or auth
  errors.
- Do not rewrite global provider auth files such as `~/.codex/auth.json`.
- Do not send tokens, API keys, raw provider files, JWT payloads, provider home
  paths, or child process handles over WebSocket.
- Do not implement all providers' native onboarding in the first final pass.
  Codex is the first native onboarding adapter; other providers must fit the
  same contracts later.

## Canonical Vocabulary

Use these product names consistently:

| Product term        | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| Provider Definition | Static provider capability/configuration contract                 |
| Account             | Credential-bearing auth record for one provider identity          |
| Runtime Profile     | Reusable template for launching agents                            |
| Agent Snapshot      | Immutable launch-time copy resolved from a runtime profile        |
| Agent Session       | Running provider process plus Paseo timeline/runtime state        |
| Account Login       | Temporary onboarding session that creates or refreshes an account |
| Account Lease       | Runtime guard/warning record for account/profile concurrency      |

Existing code may still use `ProviderAuthProfile` at the wire/storage boundary
for backward compatibility. User-facing copy should say `Account`.

## Core Decisions

1. Keep provider definitions declarative and capability-based.

   Provider definitions should describe capabilities: available models, modes,
   auth-profile support, onboarding support, account launch environment, and
   provider-specific request/runtime quirks. They should not own credentials or
   running sessions.

2. Account is the only credential owner.

   An account stores provider credentials and safe metadata. It does not store
   model, MCP, skills, permissions, or workspace defaults.

3. Runtime profile is the user-facing launch template.

   Runtime profiles reference an account and define how a future agent should
   run. Profiles are mutable templates, not running state.

4. Agent snapshot is immutable runtime input.

   Every new or restarted agent receives a resolved snapshot. Running agents
   continue from their snapshot even if the source runtime profile is edited.

5. Launch resolution is a separate backend responsibility.

   Do not scatter profile/account resolution across UI components and provider
   adapters. Add a single launch resolver that turns a draft request or runtime
   profile into an `AgentSnapshot` and `AgentLaunchContext`.

6. Account onboarding is native but isolated.

   Codex account login uses a temporary staging `CODEX_HOME`, then imports the
   resulting auth into the normal account store. Global Codex auth is never
   rewritten.

7. Account changes on active agents require explicit restart.

   Same-account selection is a no-op. Account/profile changes that affect a
   running provider process open a confirmation and use controlled restart.

8. Concurrency is policy-driven but minimal.

   Runtime profiles and accounts support `concurrencyPolicy: "allow" | "warn" |
"single-active"`. The first implementation needs enough lease tracking to
   warn or block launches; it does not need automatic quota rotation.

9. Credential pool is not the core profile model.

   A future account pool can reuse the same account and lease structures. Do not
   bake rotation/fallback into the basic runtime profile launch path.

10. All protocol changes are additive.

    Existing clients keep working. Existing agents and stored configs migrate
    lazily or receive safe defaults.

## Domain Model

### Provider Definition

```ts
type ProviderCapabilitySet = {
  provider: AgentProvider;
  supportsAuthAccounts: boolean;
  supportsNativeAccountLogin: boolean;
  supportedLoginMethods?: AccountLoginMethod[];
  supportsRuntimeProfiles: boolean;
  supportsAccountLaunchEnv: boolean;
};
```

This may be backed by existing provider registry/snapshot code. It should stay
capability-oriented rather than account-oriented.

### Account

```ts
type AccountStatus = "ready" | "needs-login" | "invalid" | "refreshing";

type ProviderAccount = {
  provider: AgentProvider;
  key: string;
  alias: string;
  email?: string;
  accountName?: string;
  accountId?: string;
  userId?: string;
  authMode: "chatgpt" | "api-key" | "oauth" | "external" | "unknown";
  plan?: string;
  status: AccountStatus;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  usage?: ProviderAuthUsageSnapshot;
};
```

Internal records may include provider home paths, token metadata, auth hashes,
and provider-specific metadata. Public records must stay sanitized.

### Account Login Session

```ts
type AccountLoginMethod = "chatgpt-device-code" | "chatgpt-browser" | "api-key";

type AccountLoginStatus =
  | "starting"
  | "pending-user"
  | "importing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

type AccountLoginSession = {
  id: string;
  provider: AgentProvider;
  method: AccountLoginMethod;
  status: AccountLoginStatus;
  verificationUrl?: string;
  userCode?: string;
  account?: ProviderAccount;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};
```

### Runtime Profile

```ts
type RuntimeProfileConcurrencyPolicy = "allow" | "warn" | "single-active";

type RuntimeProfile = {
  id: string;
  version: number;
  name: string;
  provider: AgentProvider;
  accountKey?: string | null;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  instructionOverlay?: string | null;
  systemPrompt?: string | null;
  featureValues?: Record<string, unknown>;
  envOverlay?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  concurrencyPolicy: RuntimeProfileConcurrencyPolicy;
  createdAt: string;
  updatedAt: string;
};
```

Keep the first version sparse. Empty fields mean "use current provider/app
defaults".

### Agent Snapshot

```ts
type AgentProfileSnapshot = {
  sourceProfileId?: string;
  sourceProfileVersion?: number;
  provider: AgentProvider;
  accountKey?: string | null;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  instructionOverlay?: string | null;
  systemPrompt?: string | null;
  featureValues?: Record<string, unknown>;
  envOverlay?: Record<string, string>;
  concurrencyPolicy?: RuntimeProfileConcurrencyPolicy;
  resolvedAt: string;
};
```

Snapshots are stored with the agent config and never read live profile values
while the agent is running. Workspaces own `cwd`; runtime profiles only own
provider/runtime/account selections and provider feature values. Older stored or
wire `featureDefaults` values are migrated into `featureValues`.

### Launch Resolution

```ts
type ResolvedAgentLaunch = {
  config: AgentSessionConfig;
  snapshot: AgentProfileSnapshot;
  launchContext: AgentLaunchContext;
  warnings: RuntimeLaunchWarning[];
};
```

The app can surface warnings before launch when needed, but provider secrets and
paths stay server-side.

## Storage Layout

```text
$PASEO_HOME/
  provider-auth/
    registry.json
    <provider>/
      pending/
        <loginSessionId>/
          <provider-home>/
      profiles/
        <accountKey>/
          <provider-home>/
          account.json
  runtime-profiles/
    profiles.json
  agents/
    <workspace>/
      <agentId>.json
```

Storage rules:

- `provider-auth` owns credentials and provider homes.
- `runtime-profiles` owns templates only; no raw secrets.
- `agents` owns snapshots and runtime state.
- Writes are atomic.
- Sensitive account files receive best-effort private permissions.
- Migrations are additive and backward-compatible.

## Backend Architecture

```text
ProviderRegistry
  -> capabilities and provider definitions

AuthAccountService
  -> account storage, import, refresh, remove, default, launch auth context

AccountOnboardingService
  -> temporary login sessions, Codex device-code adapter, cleanup

RuntimeProfileService
  -> profile CRUD, defaults, validation, versioning

LaunchResolver
  -> draft/profile/account/defaults -> ResolvedAgentLaunch

AccountLeaseCoordinator
  -> active account/profile warnings and single-active enforcement

AgentManager
  -> accepts resolved snapshots, owns runtime lifecycle
```

### Provider Registry

Responsibilities:

- expose provider capabilities to app/CLI;
- expose auth account support and native login support;
- expose supported models/modes/features;
- keep provider-specific behavior in provider adapters.

### AuthAccountService

Responsibilities:

- list sanitized accounts;
- import current/provider files;
- refresh account metadata;
- remove accounts;
- set provider default account;
- sync current auth where supported;
- resolve account launch context for a selected provider/account;
- coordinate sensitive writes with an account-level lock.

### AccountOnboardingService

Responsibilities:

- start/cancel/list account login sessions;
- create staging provider homes;
- run provider-specific login adapters;
- import successful login output through `AuthAccountService`;
- emit sanitized WebSocket updates;
- cleanup staging state.

Codex first adapter:

- spawn short-lived `codex app-server` with staging `CODEX_HOME`;
- use app-server auth JSON-RPC for device-code login;
- import staged `auth.json`;
- never write global `~/.codex/auth.json`.

### RuntimeProfileService

Responsibilities:

- create/update/delete/list runtime profiles;
- validate provider/account/model references;
- version profiles on each save;
- provide default profiles by provider if useful;
- never resolve secrets or provider paths.

### LaunchResolver

Responsibilities:

- resolve create-agent drafts and runtime profile selections;
- apply profile defaults and per-launch overrides;
- resolve default/explicit account through `AuthAccountService`;
- produce immutable `AgentProfileSnapshot`;
- produce `AgentLaunchContext.env`;
- return warnings from `AccountLeaseCoordinator`.

### AccountLeaseCoordinator

Responsibilities:

- track active agent leases by account key and runtime profile id;
- implement `allow`, `warn`, and `single-active`;
- release leases when agents close/archive/restart away from the account;
- surface warnings without exposing secrets.

This is not automatic credential rotation.

### AgentManager

Responsibilities:

- accept resolved config/snapshot/launch context;
- persist the snapshot with the agent;
- preserve snapshot across normal resume;
- use controlled restart when applying a new account or updated profile;
- keep old session alive when replacement launch fails.

AgentManager should not know how to login accounts or edit runtime profiles.

## WebSocket RPC Plan

All additions are new message families or optional fields.

Account RPC:

- `list_provider_accounts_request/response`
- `import_provider_account_request/response`
- `refresh_provider_account_request/response`
- `remove_provider_account_request/response`
- `set_default_provider_account_request/response`

Compatibility note: existing `provider_auth_profile` RPCs can remain as aliases
or legacy names while the app moves to account terminology.

Account login RPC:

- `list_account_login_methods_request/response`
- `start_account_login_request/response`
- `account_login_update`
- `cancel_account_login_request/response`
- `list_account_login_sessions_request/response`

Runtime profile RPC:

- `list_runtime_profiles_request/response`
- `create_runtime_profile_request/response`
- `update_runtime_profile_request/response`
- `delete_runtime_profile_request/response`
- `runtime_profiles_update`

Launch/agent RPC:

- Add optional `runtimeProfileId` and `profileOverrides` to create-agent draft
  and request paths.
- Add optional `profileSnapshot` to agent snapshots/updates for new clients.
- Add `restart_agent_with_runtime_profile_request/response`.
- Keep `restart_agent_with_auth_profile_request/response` as a narrower
  account-switch path or implement it through the same restart resolver.

Feature flags:

- `providerAuthAccounts`
- `providerAccountOnboarding`
- `runtimeProfiles`
- `agentProfileSnapshots`

## Frontend Product Surfaces

### Provider Settings: Accounts

Expected behavior:

- shows sanitized accounts for the selected provider;
- primary action: `Add account`;
- secondary action: `Import current`;
- row actions: set default, refresh, remove;
- Codex `Add account` opens device-code login sheet;
- login sheet shows code/link, pending state, cancel, retry/error, completed.

### Runtime Profiles

Expected behavior:

- list profiles with provider, account, model, mode, and status summary;
- create profile from scratch;
- create profile from current composer/agent settings;
- edit provider/account/model/reasoning/permissions/MCP/skills/env/workspace
  defaults;
- show warnings for missing/invalid account or provider unavailable;
- profile edits affect future launches only.

### Composer Preferences

Expected behavior:

- primary selection can be runtime profile;
- account/model rows still exist as resolved/editable fields;
- per-launch overrides can be saved back to a profile or used once;
- starting an agent stores an immutable snapshot.

### Active Agent Preferences

Expected behavior:

- shows source runtime profile and snapshot details;
- if source profile changed, show explicit actions:
  - `Start new agent from updated profile`;
  - `Restart this agent with updated profile`;
  - `Switch account and restart`;
- no silent mutation of running processes.

## User-Facing Behavior Rules

- Adding an account never changes running agents.
- Editing a runtime profile never changes running agents.
- Starting a new agent from a profile uses the latest profile version.
- Resuming an agent uses its stored snapshot and account key.
- Switching an active agent account/profile requires confirmation.
- If restart fails, the old agent remains usable.
- Same-account switch is a no-op.
- Missing account blocks launch with a clear message.
- Same account/profile concurrency follows profile policy.

## Security And Privacy

- Account credentials stay under `$PASEO_HOME/provider-auth`.
- Public RPC payloads are sanitized.
- Logs never include token values, raw auth files, API keys, or JWT payloads.
- Provider home paths are not exposed to clients.
- Temporary onboarding homes are removed after terminal login state.
- Account refresh writes are coordinated by account/provider lock.
- API-key entry needs a deliberate secret-input UX; do not improvise it in a
  text field that may leak into logs or snapshots.

## Migration And Compatibility

Existing branch state:

- `ProviderAuthProfile` exists and can be mapped to `ProviderAccount`.
- `authProfileKey` already exists on agents and drafts.
- Controlled account restart exists.
- Existing clients know none of the new runtime profile RPCs.

Migration strategy:

- keep `authProfileKey` as an accepted field;
- add `profileSnapshot` optional field to persisted agents;
- for old agents without `profileSnapshot`, synthesize a snapshot from stored
  provider/model/mode/auth fields on load;
- keep current account import/list RPCs while adding account-named aliases or
  app-level terminology;
- never require a runtime profile to start an agent. Direct/draft launch remains
  valid and produces an ad-hoc snapshot.

## Implementation Plan

The final product should be implemented as one branch with ordered internal
slices. Do not stop after onboarding-only.

### Slice 1: Canonical Types And Storage

- Add account terminology aliases/types while preserving existing
  `ProviderAuthProfile` compatibility.
- Add `RuntimeProfile` and `AgentProfileSnapshot` schemas.
- Add runtime profile storage with atomic read/write.
- Add migration/synthesis for agents without snapshots.

### Slice 2: Launch Resolver

- Add `LaunchResolver`.
- Resolve draft create-agent requests into `ResolvedAgentLaunch`.
- Merge runtime profile defaults, per-launch overrides, account launch context,
  and existing provider launch env.
- Add unit tests for direct launch, profile launch, override precedence, missing
  account, and snapshot immutability.

### Slice 3: AgentManager Integration

- Persist `profileSnapshot` on create/restart.
- Resume from stored snapshot.
- Route account restart and runtime-profile restart through the same resolver.
- Keep old session alive on failed restart.
- Add targeted `agent-manager` tests.

### Slice 4: Account Onboarding

- Extract shared Codex app-server JSON-RPC transport.
- Add `AccountOnboardingService`.
- Add Codex device-code adapter with staging `CODEX_HOME`.
- Import successful login output through existing account service.
- Add fake app-server tests; no real auth in automated tests.

### Slice 5: Runtime Profile RPC

- Add additive WebSocket schemas.
- Add session handlers.
- Add daemon-client methods.
- Add feature flags.
- Add schema/client tests.

### Slice 6: App Accounts UI

- Rename UI copy from auth profiles to accounts where appropriate.
- Add `Add account` flow for Codex.
- Keep `Import current` as fallback.
- Refetch accounts after login completion.

### Slice 7: App Runtime Profile UI

- Add runtime profile list/editor.
- Add profile selector to composer Preferences.
- Allow ad-hoc launch overrides.
- Add active-agent profile snapshot display and explicit restart/apply actions.

### Slice 8: Concurrency Policy

- Add account/profile lease tracking.
- Implement `allow`, `warn`, `single-active`.
- Surface warnings before launch/restart.
- Do not implement automatic quota fallback in this slice.

### Slice 9: Validation And Live QA

- Run targeted tests for changed server units.
- Run targeted app tests if available.
- Run `npm run format:files -- <changed files>`.
- Run `npm run lint -- <changed files>`.
- Run `npm run typecheck`.
- Live test:
  - add Codex account from Paseo;
  - create runtime profile with that account/model/settings;
  - start new agent from profile;
  - edit profile and confirm running agent keeps old snapshot;
  - start second agent and confirm it uses new profile version;
  - restart first agent with updated profile;
  - test account switch restart;
  - test concurrency warning or block.

## Definition Of Done

- Accounts can be added from Paseo for Codex using device-code login.
- Accounts remain isolated from global provider auth files.
- Runtime profiles can be created, edited, listed, and deleted.
- Runtime profiles can select account, provider, model, reasoning/mode, MCP,
  skills/instructions, permissions, env, and workspace defaults.
- New agents can start from runtime profiles.
- Direct/ad-hoc agent launch still works.
- Every launched agent stores an immutable profile snapshot.
- Profile edits affect future agents only.
- Existing agents can explicitly restart with updated profile or different
  account.
- Failed restart leaves the old agent usable.
- Resume uses the stored snapshot.
- Concurrency policy can allow, warn, or block same-account/profile launches.
- Secrets never cross WebSocket or logs.
- Old clients and old stored agents keep working.

## Final Architecture Rule

Keep the system small:

```text
Provider definitions describe capability.
Accounts hold credentials.
Runtime profiles describe intent.
Snapshots launch agents.
Agent sessions run and stream.
```

If a future idea does not fit one of those five slots, it should not be added
until the slot boundary is made explicit.
