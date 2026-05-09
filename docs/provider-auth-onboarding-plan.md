# Provider Auth Onboarding Plan

Status: decision-complete draft; implementation not started
Branch: `codex/provider-auth-profiles`
Related plan: [provider-auth-profiles-plan.md](./provider-auth-profiles-plan.md)
Superseded by: [provider-runtime-profiles-final-plan.md](./provider-runtime-profiles-final-plan.md)

This document remains the focused account-onboarding sub-plan. The canonical
final product plan is now the runtime profiles plan, which covers accounts,
runtime profiles, launch snapshots, active-agent restart behavior, and
concurrency policy together.

## Current Baseline

Paseo already has a provider-neutral auth profile layer on this branch:

- Codex accounts can be imported from the current global Codex auth file or from
  an auth file.
- Accounts are stored as isolated provider homes under Paseo-managed storage.
- Codex launches receive `CODEX_HOME=<profile codex-home>` through the existing
  provider launch context.
- Provider settings can list, refresh, remove, and set defaults for profiles.
- Composer Preferences can select an account for new agents.
- Active agents can switch accounts through an explicit controlled restart.
- Current global Codex auth is auto-synced before profile listing and new agent
  launch selection.

The remaining gap is account onboarding. Today, a user still needs to log in
through the provider's own tool first, then let Paseo import or sync that login.
This plan adds native Paseo account login/pairing so the app can create and
persist provider auth profiles without requiring a separate provider CLI flow.

This plan also clarifies the product boundary between auth accounts and future
runtime profiles. Auth onboarding creates accounts. A higher-level
profile system can later combine an account with provider, model, MCP servers,
skills, instructions, permissions, and other runtime defaults.

## References

- `codex-auth` is a behavior reference for multiple Codex auth snapshots and
  profile switching, but it should not become a Paseo runtime dependency.
- The OpenAI Codex app-server auth surface exposes JSON-RPC methods for
  `account/read`, `account/login/start`, `account/login/cancel`,
  `account/logout`, and rate-limit reads. It supports ChatGPT browser login and
  ChatGPT device-code login. Device-code login returns a verification URL,
  user code, and login id, then emits login completion notifications.

Primary source:

- <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints>

## Goal

Add native provider auth onboarding to Paseo so a user can add accounts from
Paseo itself, persist each account as an isolated provider auth profile, and use
those accounts for new agents or controlled active-agent restarts.

Codex is the first implementation. The architecture must stay provider-neutral
so Claude, OpenCode, Pi, or custom provider auth flows can be added later
without redesigning the app UI or WebSocket contract.

## Non-Goals

- Do not implement automatic account rotation or quota-based fallback in this
  scope.
- Do not silently switch running agents to a different account.
- Do not rewrite the user's global provider auth files.
- Do not send access tokens, refresh tokens, API keys, raw `auth.json`, or JWT
  payloads to the app.
- Do not depend on `codex-auth` or parse provider CLI stdout as the primary
  integration.
- Do not implement Claude/OpenCode/Pi onboarding in the MVP.
- Do not promise provider-side conversation continuity across account changes.
  Paseo can preserve its timeline, but provider processes are restarted under
  the selected account.
- Do not make mutable provider profile changes automatically rewrite already
  running agent sessions. Existing agents must stay on the launch-time snapshot
  unless the user explicitly restarts or reapplies a profile.

## Core Decisions

1. Add a provider-neutral onboarding layer above provider auth profiles.

   The existing profile service owns stored profiles and launch resolution.
   The new onboarding layer owns long-running login sessions: start, expose
   public status, receive provider completion, import the resulting profile,
   cancel, timeout, and clean up staging files.

2. Codex onboarding uses Codex app-server device-code auth first.

   Paseo should start a short-lived Codex app-server process with an isolated
   staging `CODEX_HOME`, initialize the JSON-RPC client, call
   `account/login/start` with `type: "chatgptDeviceCode"`, show the returned
   verification URL and user code in the app, and wait for
   `account/login/completed`.

3. Staging homes are temporary; profile homes remain the permanent storage.

   The Codex login process writes auth into:

   ```text
   $PASEO_HOME/provider-auth/codex/pending/<loginSessionId>/codex-home/
   ```

   On success, Paseo imports the staged `auth.json` through the same Codex auth
   adapter used by manual imports. The permanent profile still lands under:

   ```text
   $PASEO_HOME/provider-auth/codex/profiles/<profileKey>/codex-home/
   ```

   After successful import, cancel, failure, or expiry, the pending home is
   removed best-effort.

4. Use app-server JSON-RPC directly, not `codex login --device-auth`.

   The CLI login command is useful as a user-facing fallback, but it is a poor
   native integration boundary because Paseo would need to parse terminal
   output, detect prompts, and manage provider-specific interactivity. The
   app-server auth API already exposes structured request/response and
   notification payloads.

5. Extract a reusable local JSON-RPC child-process client.

   `codex-app-server-agent.ts` already contains JSON-RPC stdio client logic for
   agent sessions. Onboarding should not copy that code. Extract the generic
   child-process JSON-RPC transport into a small server-side utility, then use
   it from both the Codex agent provider and the Codex onboarding adapter.

6. Keep login sessions server-side and sanitized.

   The app receives only public state: provider, method, session id, status,
   verification URL, user code, timestamps, profile metadata after completion,
   and safe error messages. Process handles, staging paths, tokens, raw files,
   and provider protocol details stay in the daemon.

7. Preserve existing import/sync/switch semantics.

   Native onboarding creates or updates profiles. It does not remove the manual
   `Import current` recovery path, does not change current-auth auto-sync, and
   does not change controlled active-agent restart semantics.

8. Separate auth accounts from runtime profiles.

   The current `ProviderAuthProfile` is an account/credential record. It should
   not grow into a catch-all runtime profile. A future runtime profile
   should reference an auth account and also own configurable runtime defaults:
   provider, model, reasoning effort, MCP server set, skills, instructions,
   permissions, feature toggles, environment overlays, and workspace defaults.

9. Agent sessions use immutable launch snapshots.

   A runtime profile is a mutable template for future sessions. When an
   agent starts, Paseo should snapshot the selected profile into that agent's
   session config. Later edits to the profile should affect new agents only.
   Existing agents continue in the same workspace with the same launch snapshot
   until the user explicitly chooses an action such as "restart with updated
   profile" or "switch account and restart".

10. Concurrency policy belongs above auth storage.

    Multiple different accounts can run concurrently. Multiple agents can also
    reference the same runtime profile, but the auth account underneath
    may have provider-specific refresh-token risks. The profile layer should
    eventually declare a concurrency policy such as `allow`, `warn`, or
    `single-active`, while the onboarding layer remains responsible only for
    creating and maintaining the account records.

## Domain Model

Public shape:

```ts
type ProviderAuthLoginMethod = "chatgpt-device-code" | "chatgpt-browser" | "api-key";

type ProviderAuthLoginStatus =
  | "starting"
  | "pending-user"
  | "importing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

type ProviderAuthLoginSession = {
  id: string;
  provider: AgentProvider;
  method: ProviderAuthLoginMethod;
  status: ProviderAuthLoginStatus;
  verificationUrl?: string;
  userCode?: string;
  profile?: ProviderAuthProfile;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};
```

Internal runtime shape:

```ts
type ProviderAuthLoginRuntime = {
  publicSession: ProviderAuthLoginSession;
  providerLoginId?: string;
  stagingHomePath: string;
  dispose: () => Promise<void>;
  cancel: () => Promise<void>;
};
```

Only the public shape crosses WebSocket RPC.

Future runtime profile shape:

```ts
type ProviderWorkingProfile = {
  id: string;
  name: string;
  provider: AgentProvider;
  authProfileKey?: string | null;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  instructionOverlay?: string | null;
  systemPrompt?: string | null;
  featureValues?: Record<string, unknown>;
  envOverlay?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  concurrencyPolicy?: "allow" | "warn" | "single-active";
  createdAt: string;
  updatedAt: string;
};

type AgentProfileSnapshot = {
  sourceProfileId?: string;
  sourceProfileVersion?: string;
  provider: AgentProvider;
  authProfileKey?: string | null;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  instructionOverlay?: string | null;
  systemPrompt?: string | null;
  featureValues?: Record<string, unknown>;
  envOverlay?: Record<string, string>;
};
```

The onboarding MVP does not need to implement `ProviderWorkingProfile`, but the
auth model should not block it.
Runtime profiles are not workspace owners: `cwd` stays on the workspace/agent
launch path, and deprecated `featureDefaults` inputs are folded into
`featureValues`.

## Server Architecture

Add a new service:

```text
packages/server/src/server/agent/provider-auth-onboarding-service.ts
```

Responsibilities:

- keep an in-memory registry of active login sessions;
- start provider-specific onboarding adapters;
- emit sanitized session updates through the existing session/broadcast layer;
- call `ProviderAuthService.importProfile` after a provider login succeeds;
- invalidate/list profiles after completion;
- cancel and timeout pending sessions;
- clean up child processes and pending homes.

Add a provider-specific adapter:

```text
packages/server/src/server/agent/provider-auth-codex-onboarding.ts
```

Responsibilities:

- create a pending Codex home;
- spawn `codex app-server` with `CODEX_HOME=<pending codex-home>`;
- initialize app-server with Paseo client info;
- start device-code login;
- listen for `account/login/completed` and `account/updated`;
- expose cancellation via `account/login/cancel`;
- surface app-server failures as sanitized errors.

Refactor shared JSON-RPC transport:

```text
packages/server/src/server/agent/providers/codex-app-server-json-rpc.ts
```

or a more generic location if the extracted client is provider-independent.

The extraction should preserve existing Codex agent behavior and tests.

## RPC Plan

All WebSocket changes must be additive.

New request/response families:

- `list_provider_auth_login_methods_request`
  - provider optional or required;
  - returns methods supported by each provider.
- `start_provider_auth_login_request`
  - `provider: AgentProvider`
  - `method: ProviderAuthLoginMethod`
  - optional `alias`
  - optional future method-specific payload.
- `start_provider_auth_login_response`
  - returns the public `ProviderAuthLoginSession`.
- `provider_auth_login_update`
  - server-initiated public session update.
- `cancel_provider_auth_login_request`
  - `loginSessionId: string`
- `cancel_provider_auth_login_response`
  - returns the cancelled or current public session.
- `list_provider_auth_login_sessions_request`
  - optional recovery path for reconnecting clients.

Compatibility rules:

- do not change existing provider auth profile messages except optional fields;
- expose a new feature flag such as `providerAuthOnboarding`;
- old clients continue to use manual import/sync;
- new clients call onboarding RPCs only when the feature flag is present.

## App Architecture

Provider settings Accounts section:

- Replace the primary "Import current" affordance with "Add account".
- Keep "Import current" available as a secondary recovery action.
- For Codex MVP, "Add account" opens a method sheet with "Sign in with
  ChatGPT" backed by device-code login.
- The login sheet displays the verification URL and user code, with copy/open
  actions where the platform supports them.
- Completion closes or transitions the sheet and shows the created account row.
- Failure keeps the sheet open with the sanitized error and retry/cancel
  actions.

Composer Preferences:

- No new primary control is needed.
- Once onboarding creates profiles, the existing Account row lists them.
- Active-agent account changes continue to use the explicit restart flow.

State management:

- Add a small hook such as `useProviderAuthLogin`.
- Keep auth login query/mutation keys separate from provider model snapshots and
  provider auth profile list queries.
- Invalidate provider auth profile queries when a login completes.

Future provider profile UI:

- Add a separate "Profiles" surface after account onboarding is stable.
- A profile row should show provider, account, model, and compact runtime
  defaults.
- Editing a profile should affect future agents only.
- For an active agent, profile edits should surface explicit actions such as
  "start new agent from updated profile" or "restart this agent with updated
  profile"; they should never silently mutate the running process.
- If the selected auth account is already active in another Codex process, the
  first version may show a warning. A later version can enforce a stricter
  profile or account concurrency policy.

## Codex Device-Code Flow

Expected MVP flow:

1. User opens Settings, selects Codex, taps "Add account".
2. App sends `start_provider_auth_login_request`.
3. Daemon creates a pending Codex home and starts Codex app-server with that
   staging `CODEX_HOME`.
4. Daemon initializes app-server and calls `account/login/start` with
   `type: "chatgptDeviceCode"`.
5. Daemon returns `verificationUrl`, `userCode`, and login session id.
6. App shows the code and link to the user.
7. User completes auth in browser.
8. Codex app-server emits completion/update notifications and writes auth files
   into the staging home.
9. Daemon imports staged `auth.json` through the existing Codex auth adapter.
10. Profile list updates, staging process exits, and pending files are cleaned.
11. User can set the new profile as default, select it for a new agent, or
    restart an existing agent with it.

## Failure Model

- User cancels: send `account/login/cancel`, stop child process, remove pending
  home, emit `cancelled`.
- User never completes auth: expire the login session after a bounded timeout,
  stop child process, remove pending home, emit `expired`.
- Codex app-server exits early: emit `failed` with sanitized stderr context.
- Login completes but no `auth.json` exists: emit `failed`, keep no partial
  profile, remove pending home.
- Import parses a duplicate account: update the existing profile via current
  import/upsert semantics.
- Profile import succeeds but cleanup fails: keep the profile, log cleanup
  warning without exposing sensitive paths to the app.
- App disconnects mid-login: session continues until completion, cancellation,
  or timeout; reconnecting clients can list active login sessions.
- The same auth account is used by multiple Codex processes: allow for MVP only
  with explicit risk tracking or UI warning. A later concurrency coordinator can
  enforce `single-active` or serialize account-sensitive operations if provider
  behavior requires it.

## Security And Privacy

- Secrets remain server-side.
- Staging paths and permanent profile homes are never sent to the app.
- Logs must not contain token values, raw `auth.json`, API keys, or JWT payloads.
- Pending homes are deleted best-effort after terminal states.
- Sensitive file writes should preserve or improve current private-permission
  behavior.
- API-key onboarding is deferred until the UI has a safe secret-entry pattern.
- Browser login is deferred until local callback behavior is proven safe across
  remote/mobile clients.
- When the same auth account is used concurrently, provider token refresh can be
  account-sensitive. Do not assume all providers can safely share one mutable
  credential home across unlimited concurrent child processes.

## Provider Extensibility

Provider onboarding adapters should report capabilities rather than forcing a
single Codex-shaped flow:

```ts
type ProviderAuthOnboardingCapabilities = {
  methods: ProviderAuthLoginMethod[];
  supportsCancel: boolean;
  supportsReconnectStatus: boolean;
};
```

Future providers can map into the same public session contract:

- Claude: likely external OAuth/browser or copied credential store, exact flow
  to be researched.
- OpenCode: likely provider/config dependent, exact auth store to be researched.
- Pi: likely provider-specific account/token flow, exact auth store to be
  researched.
- Custom providers: likely API-key or environment-token onboarding, should be
  explicit and opt-in.

## Implementation Phases

### Phase 0: Decision and architecture dossier

- Land this decision plan.
- Produce the architecture dossier from this plan so reference projects can be
  compared on the same axes before implementation.
- Revise this plan after comparison if another reference proves a better
  boundary.
- Include the account/profile/session snapshot distinction in the dossier.

### Phase 1: Shared Codex app-server JSON-RPC transport

- Extract the current Codex app-server JSON-RPC child client.
- Keep existing Codex agent provider behavior unchanged.
- Add targeted tests around request/response, notification, timeout, and child
  exit behavior.

### Phase 2: Provider auth onboarding service

- Add sanitized login-session types.
- Add in-memory login session registry.
- Add timeout/cancel/final-state cleanup semantics.
- Add fake provider adapter tests for lifecycle correctness.

### Phase 3: Codex device-code adapter

- Spawn Codex app-server with staging `CODEX_HOME`.
- Initialize app-server.
- Start `chatgptDeviceCode` login.
- Handle completion notification.
- Import staged auth through `ProviderAuthService.importProfile`.
- Add fake app-server tests; do not require real OpenAI auth in automated tests.

### Phase 4: RPC and daemon client

- Add additive message schemas.
- Add session handlers.
- Add daemon client methods.
- Add schema/client tests where the repo has existing coverage patterns.

### Phase 5: App UI

- Add `useProviderAuthLogin`.
- Add "Add account" flow in provider settings Accounts.
- Keep "Import current" as secondary fallback.
- Invalidate/refetch profiles after completion.
- Do not add the full runtime profile editor in this phase; keep it as
  the next product layer after account onboarding.

### Phase 6: Validation

- Run targeted tests for changed server files.
- Run targeted app tests if component/hook test patterns are available.
- Run `npm run format:files -- <changed files>`.
- Run `npm run lint -- <changed files>`.
- Run `npm run typecheck`.
- Live validation with the user:
  - add a new Codex account from Paseo device-code flow;
  - confirm it appears as a profile without external CLI login;
  - set it as default;
  - start a new Codex agent with it;
  - switch an existing agent to it through controlled restart.

## Definition Of Done

- A user can add a Codex ChatGPT account from Paseo using device-code login.
- The resulting account is persisted as a normal provider auth profile.
- The new profile is selectable for new Codex agents.
- Existing controlled restart can move an active agent to the new profile.
- Manual import and automatic current-auth sync still work.
- Duplicate logins update existing profiles instead of creating duplicates.
- Cancelling or expiring a login leaves no usable partial profile.
- Provider secrets never cross WebSocket RPCs or logs.
- Old clients remain compatible with the daemon.
- The plan leaves a clean path for runtime profiles where account,
  provider, model, MCP, skills, instructions, permissions, and env defaults are
  saved as a mutable template for future sessions.
- Running agents remain bound to launch-time snapshots and are not silently
  changed when a profile template is edited.

## Architecture Dossier To Produce Next

The next document should turn this plan into a comparison-ready architecture
record. It should capture the same facts for Paseo and every reference project:

- product goal and user flow;
- provider auth protocol used;
- account versus working-profile boundary;
- process model;
- persistence model;
- launch snapshot semantics;
- profile identity and deduplication strategy;
- account switching semantics;
- concurrent account support;
- provider/profile concurrency policy;
- UI surface and user confirmation model;
- secret handling and log redaction;
- failure/cancel/timeout model;
- provider extensibility points;
- tests and live validation strategy;
- risks and unresolved provider-specific questions.

The first comparison set should include:

- this Paseo plan;
- `Loongphy/codex-auth`;
- OpenAI Codex app-server auth endpoints;
- any additional provider auth systems we inspect next.
