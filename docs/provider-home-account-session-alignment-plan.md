# Provider Home, Account, and Session Alignment Decision

Status: accepted plan for Codex-first implementation.

This document is the source of truth for aligning provider-native sessions,
Paseo provider accounts, runtime profiles, account switching, and import
session behavior.

## Problem

Paseo now has two provider layers:

- Upstream/native layer: providers use their own homes and native session files.
- Paseo account/profile layer: Paseo creates managed provider homes and exposes
  account/runtime profile UI on top.

The current code often treats `authProfileKey` as "the account". For Codex, that
is not precise enough. Selecting an auth profile changes `CODEX_HOME`, and
native Codex session continuity depends on the provider home that owns the
rollout/session files.

For Codex:

- Native Codex default home: `~/.codex`
- Paseo managed profile home:
  `$PASEO_HOME/provider-auth/codex/profiles/<profileKey>/codex-home`

The same account can exist in both homes. The native session file can exist in
only one home. That is the root cause of repeated fixes around import session,
custom settings, account switch, and runtime profile switch.

## Scope

In scope:

- Provider settings account list/default/refresh/remove.
- Codex `Add account` device-code login.
- `Import current` provider auth.
- Automatic current-auth sync.
- New agent account/runtime profile selection.
- Custom settings account/runtime profile selection.
- Runtime profile editor account/session behavior.
- Existing agent account switch.
- Existing agent runtime profile switch.
- Import session and source account selection.
- Imported-agent follow-up switching.
- CLI import/session commands where they touch provider sessions.

Out of scope:

- Paseo daemon/device pairing.
- Relay pairing.
- QR pairing.
- Connection-offer flows.

Those connect a client to a Paseo daemon. They do not create provider accounts,
provider homes, or provider-native sessions.

## Upstream Baseline

Upstream `main` has a simpler model:

- Provider list/settings/diagnostics.
- Custom provider installation.
- Native provider session import.
- Codex/Claude/OpenCode provider session resume/create.
- No provider-auth profile registry.
- No account onboarding.
- No runtime profile account selection.
- No account picker in import session.

Paseo must preserve upstream's native provider/session behavior while adding
managed provider homes as a first-class concept.

## Decisions

1. Provider home is the launch identity.

   Runtime launch, resume, import, and account switch decisions use a
   provider-home reference first. Account metadata is descriptive.

2. Native provider default is first-class.

   `~/.codex` is not a null/default fallback. It is a real Codex provider home
   and must be represented explicitly in server state and UI.

3. Managed profiles are provider homes.

   A saved Paseo auth profile is not only an account. It is a managed provider
   home plus sanitized account metadata.

4. `authProfileKey` leaves the product model.

   New internal state, UI decisions, launch resolution, and persistence writes
   use `providerHomeRef`. Deprecated `authProfileKey` is accepted only at the
   protocol/storage read boundary, then immediately normalized to
   `providerHomeRef`. That boundary is tagged with `COMPAT(providerHomeRef)`.

5. Runtime profiles are templates.

   Runtime profiles can choose model, mode, prompt, reasoning, concurrency,
   session behavior, and an explicit provider home override. They do not own
   native session identity, and they do not implicitly switch account/home unless
   they carry an explicit `providerHomeRef`.

6. Source continuity is the default.

   Imported sessions continue from the provider home that owns the native
   session unless the user explicitly selects another provider home.

7. Fresh session is explicit.

   Paseo must not silently lose provider-native context. If continuing is not
   possible, the user must see and confirm a fresh-session decision.

8. Cross-home continuity is capability-gated.

   Cross-home continuation is a product target. It is not assumed safe. Each
   provider adapter must classify the transition before Paseo resumes, clones,
   or starts fresh.

9. Same account in different homes is shown as different launch targets.

   UI cannot collapse two homes into one row because their session continuity
   behavior differs.

10. No provider auth file rewrites.

    Paseo must not rewrite native provider auth files as part of this plan.
    `Import current` copies auth into managed storage; it does not move native
    sessions.

## Terms

### Provider Home

Filesystem root used by the native provider for auth, config, and session files.

Examples:

- Codex native default: `~/.codex`
- Codex managed profile:
  `$PASEO_HOME/provider-auth/codex/profiles/<key>/codex-home`
- Claude native default: `~/.claude`
- OpenCode native default: provider-specific config/session root

### Provider Account

Sanitized identity found inside a provider home: email, display name, account
id, user id, plan, auth status, and usage metadata where available.

### Provider Home Reference

Stable launch/session identity for a provider home.

```ts
type ProviderHomeRef =
  | {
      kind: "native-default";
      provider: AgentProvider;
      homePath: string;
      accountFingerprint?: string | null;
      label?: string | null;
    }
  | {
      kind: "managed-profile";
      provider: AgentProvider;
      profileKey: string;
      homePath: string;
      accountFingerprint?: string | null;
      label?: string | null;
    };
```

### Continuity Decision

Provider-specific decision for a source native session and a target provider
home.

```ts
type ProviderSessionContinuityDecision =
  | {
      kind: "native-resume-supported";
      sourceHomeRef: ProviderHomeRef;
      targetHomeRef: ProviderHomeRef;
    }
  | {
      kind: "clone-required";
      sourceHomeRef: ProviderHomeRef;
      targetHomeRef: ProviderHomeRef;
      reason: string;
    }
  | {
      kind: "fresh-required";
      sourceHomeRef: ProviderHomeRef | null;
      targetHomeRef: ProviderHomeRef;
      reason: string;
    }
  | {
      kind: "blocked-needs-confirmation";
      reason: string;
    };
```

## Target Flow

Every provider launch or relaunch follows one path:

1. Resolve selected provider.
2. Resolve selected provider home.
3. Resolve account metadata for that home.
4. Resolve native session source, if any.
5. Ask provider session resolver for a continuity decision.
6. Launch by provider home.
7. Persist the provider home and continuity decision.

No UI surface should independently interpret deprecated account keys, default
account, source account, or provider home.

## Backend Architecture

### ProviderHomeRegistry

Provider-neutral registry for available homes.

Responsibilities:

- Return native default home.
- Return Paseo managed homes.
- Attach sanitized account metadata.
- Detect duplicate accounts across homes.
- Produce UI labels.
- Resolve only `ProviderHomeRef` values. Deprecated protocol fields are
  normalized before this registry is called.

### ProviderAccountResolver

Provider-specific account inspection.

Responsibilities:

- Read account metadata from a provider home.
- Produce stable account fingerprint.
- Never expose raw auth files, access tokens, refresh tokens, API keys, or JWTs.
- Mark status: `ready`, `needs-login`, `invalid`, `refreshing`, or `unknown`.

Codex fingerprint order:

1. Stable user/account id from token claims.
2. Normalized email only as fallback.
3. Stable hash of auth data only for unknown/API-key modes.

### ProviderSessionResolver

Provider-specific native session discovery and continuity.

Responsibilities:

- List native sessions for a provider home.
- Resolve a native session id to the source provider home that owns it.
- Classify source-home to target-home continuity.
- Declare whether direct resume, clone/import, or fresh session is required.

Codex first implementation:

- Same-home resume is supported.
- Cross-home direct resume must be tested.
- Cross-home clone/import must not run until proven safe.
- Fresh fallback requires explicit confirmation.

### LaunchResolver

The only backend entry point that turns UI/RPC input into launch state.

Outputs:

- `providerHomeRef`
- provider env, for Codex `CODEX_HOME`
- normalized session behavior
- account warning state
- continuity decision
- persisted profile snapshot

Consumers:

- New agent.
- Import session.
- Custom settings.
- Account switch.
- Runtime profile switch.
- Existing agent resume.
- CLI import.

## Data Model

All new protocol fields are optional at the protocol boundary. Internal
normalized launch state must always have an explicit provider home.

### Agent Config

```ts
type AgentSessionConfig = {
  providerHomeRef?: ProviderHomeRef | null;
  sessionBehavior?: "continue" | "fresh";
  profileSnapshot?: {
    provider: AgentProvider;
    providerHomeRef?: ProviderHomeRef | null;
    sessionBehavior?: "continue" | "fresh";
  };
};
```

`providerHomeRef` may be omitted only by old clients or old stored data. Before
launch, import, resume, or profile switch, the daemon normalizes it into a
required `ProviderHomeRef`.

Deprecated boundary input:

```ts
type DeprecatedProviderHomeSelectionInput = {
  authProfileKey?: string | null; // COMPAT(providerHomeRef)
};
```

This type is not part of the internal model. It exists only where old protocol
messages or old stored records are parsed.

### Persistence Metadata

```ts
type AgentPersistenceMetadata = {
  provider: AgentProvider;
  threadId?: string;
  providerHomeRef: ProviderHomeRef;
  sourceProviderHomeRef?: ProviderHomeRef | null;
  accountFingerprint?: string | null;
  sessionContinuity?: {
    behavior: "continue" | "fresh";
    decision?: ProviderSessionContinuityDecision;
    sourceSessionId?: string | null;
    sourceHomeRef?: ProviderHomeRef | null;
  };
};
```

### Import Session Descriptor

```ts
type RecentProviderSessionDescriptor = {
  provider: AgentProvider;
  sessionId: string;
  title?: string | null;
  cwd?: string | null;
  sourceHomeRef?: ProviderHomeRef | null;
  account?: {
    fingerprint?: string | null;
    label?: string | null;
    email?: string | null;
  };
};
```

## Surface Decisions

### Add Provider

Decision:

- Adds provider config only.
- Does not create accounts.
- Does not import current auth.
- Does not create managed provider homes.

### Provider Settings Accounts

Decision:

- Accounts section displays provider homes with account metadata.
- Managed profiles are labeled as managed homes.
- Native default home is visible where it can be selected or explains session
  ownership.
- Same account in multiple homes appears as separate rows or separate launch
  targets.

### Codex Add Account Device-Code Login

Decision:

- Creates a managed provider home.
- Runs Codex login in a temporary staging home.
- Imports completed auth into a managed profile home.
- Removes staging home.
- Does not mutate `~/.codex`.
- Does not move native sessions.

Current path:

```text
$PASEO_HOME/provider-auth/codex/pending/<loginSessionId>/codex-home
```

Permanent path:

```text
$PASEO_HOME/provider-auth/codex/profiles/<profileKey>/codex-home
```

### Import Current Provider Account

Decision:

- Copies current native/effective auth into a managed provider home.
- Source home is recorded when available.
- Existing native sessions remain owned by the source home.
- Existing agents are not moved.

For Codex, current home is effective `CODEX_HOME` for the daemon process, or
`~/.codex`.

### Automatic Current Auth Sync

Decision:

- Updates registry metadata and managed credentials from current auth.
- Does not rewrite native auth.
- Does not relaunch running agents.
- Does not change imported session source ownership.

### New Agent

Decision:

- Account picker selects a provider home.
- Default selection is explicit.
- If no user/provider preference exists, native default home is the baseline.
- Saved managed profile default is a launch preference, not native default.

### Custom Settings

Decision:

- Model/mode/reasoning changes keep current provider home.
- Account row changes provider home.
- Provider home changes require continuity classification.
- UI shows the current provider home source.

### Runtime Profile Editor

Decision:

- Provider home override is optional and explicit.
- Empty override means "keep the current provider home" on existing agents and
  "use launch default" on new agents.
- Session behavior defaults to `continue`.
- `fresh` remains explicit.
- Runtime profile does not own native session identity.

### Existing Agent Runtime Profile Switch

Decision:

- If profile changes model/mode only, keep current provider home and native
  session.
- If profile changes provider home/account, classify continuity first.
- No silent fresh provider session.

### Existing Agent Account Switch

Decision:

- Account switch means provider home switch.
- Same provider home: no restart.
- Different provider home: central continuity decision.
- Preserve Paseo agent id and visible timeline.
- Fresh native session requires confirmation.

### Import Session

Decision:

- Each imported native session carries source provider home.
- Default action is `Source account`.
- Import with source account resumes from source home.
- Selecting another account/home starts cross-home continuity flow.
- The import sheet does not decide resume/fresh itself.

### Imported Agent Follow-Up Switch

Decision:

- Imported agents persist source provider home.
- Custom settings displays current/source provider home.
- Account/runtime switch uses the same central resolver.

### CLI Import

Decision:

- Server resolves source provider home.
- CLI may pass provider/session id only.
- Future account/home selector must use the same resolver.

### Existing Persisted Agents

Decision:

- Old agent with no provider home metadata: map to native default provider home.
- Old agent with deprecated `authProfileKey`: normalize at read time to managed
  profile home.
- Mapping is read-time compatibility only.
- New writes never persist `authProfileKey`.

### Account-In-Use Warning

Decision:

- Warning is keyed by provider home.
- Same account in two homes is not the same launch target.
- Copy says "provider home" or "source" where needed to avoid ambiguity.

## UI Copy Decisions

Use:

- `Native Codex default`
- `Managed profile: <alias>`
- `Source account`
- `Same account, different provider home`
- `Start fresh under selected account`

Avoid:

- `Default account` when it can mean native default or saved managed default.
- `Provider default` unless the provider home is shown.
- Any copy that implies `Add account` changes native Codex default.
- Any copy that implies `Import current` moves existing native sessions.

## Codex Decision

Codex is the first implementation target.

Required Codex home types:

- Native default home: `~/.codex` or effective daemon `CODEX_HOME`.
- Managed profile home: Paseo provider-auth profile home.
- Pending login home: temporary onboarding staging home.

Required Codex continuity matrix:

| Source home                     | Target home               | Required result |
| ------------------------------- | ------------------------- | --------------- |
| Native default                  | Same native default       | Resume          |
| Managed profile                 | Same managed profile      | Resume          |
| Native default                  | Managed same account      | Classify        |
| Native default                  | Managed different account | Classify        |
| Managed profile                 | Managed same account      | Classify        |
| Managed profile                 | Managed different account | Classify        |
| Paseo-created app-server thread | Different home            | Classify        |
| Imported native CLI rollout     | Different home            | Classify        |

Classify means one of:

- `native-resume-supported`
- `clone-required`
- `fresh-required`
- `blocked-needs-confirmation`

No rollout/session file clone runs until Codex-specific safety is proven.

## Provider Expansion Decision

Do not generalize behavior by guessing.

Claude and OpenCode get the same interfaces after Codex:

- provider home resolver;
- account resolver;
- session resolver;
- continuity classification;
- provider-specific tests.

Each provider defines its own home paths, account metadata, and native session
ownership rules.

## Implementation Plan

### Phase 1: Read-Only Model Alignment

Deliverables:

- Add `ProviderHomeRef`.
- Add `ProviderHomeRegistry`.
- Add Codex native default home discovery.
- Add Codex managed profile home discovery.
- Add Codex account fingerprint extraction per home.
- Add source home metadata to import descriptors.
- Persist provider home metadata for new/imported agents.
- Add UI labels for current/source provider home.

Acceptance:

- Import sheet can show the source home for Codex sessions.
- Provider settings can distinguish native default and managed homes.
- Same account in two homes appears as distinct launch targets.
- Existing agents still parse and load.

### Phase 2: Central Launch Resolution

Deliverables:

- Route new agent through provider-home resolver.
- Route import session through provider-home resolver.
- Route custom settings through provider-home resolver.
- Route account switch through provider-home resolver.
- Route runtime profile switch through provider-home resolver.
- Remove surface-local deprecated account-key decision logic.
- Add one `COMPAT(providerHomeRef)` protocol/storage read-time normalizer.
- Stop writing `authProfileKey` from new daemon code.

Acceptance:

- No UI surface independently decides native vs managed home.
- `null` is not used as a native/default home sentinel in new code.
- No internal launch resolver, snapshot, or persistence write uses
  `authProfileKey`.
- Account-in-use warnings use provider home identity.

### Phase 3: Continuity Guardrails

Deliverables:

- Add `ProviderSessionContinuityDecision`.
- Add same-home resume classification.
- Add cross-home classification for Codex.
- Block silent fresh fallback.
- Store last continuity decision in agent metadata.
- Add confirmation UI for fresh-required transitions.

Acceptance:

- Model-only changes keep current provider home.
- Import source account resumes from source home.
- Cross-home switch never silently starts fresh.

### Phase 4: Codex Cross-Home Capability Tests

Deliverables:

- Targeted tests for the Codex matrix.
- Separate Paseo-created app-server thread tests from imported CLI rollout tests.
- Document actual Codex behavior from tests.

Acceptance:

- Each Codex cross-home case has a classified outcome.
- If clone is required, no clone happens automatically.
- If direct resume works, resolver records that capability.

### Phase 5: Cleanup and UI Simplification

Deliverables:

- Remove ambiguous labels.
- Remove per-surface account/home fallback logic.
- Simplify import sheet account selection to source/default/managed homes.
- Simplify runtime profile account row to provider-home selection.
- Simplify custom settings to display current provider home.

Acceptance:

- User-facing account/profile surfaces use the same terms.
- Same account in two homes is understandable.
- `Add account`, `Import current`, and `Import session` have distinct copy.

### Phase 6: Provider Expansion

Deliverables:

- Claude provider-home/account/session resolver.
- OpenCode provider-home/account/session resolver.
- Provider-specific continuity tests.

Acceptance:

- Provider auth/profile UI is provider-neutral.
- Provider-specific session ownership stays in provider adapters.

## What Gets Removed

Remove or replace:

- Surface-local account resolution in import sheet.
- Surface-local account resolution in custom settings.
- Surface-local account resolution in runtime profile switch.
- Runtime profile switch paths that silently create fresh provider sessions.
- Account switch paths that treat deprecated account keys as launch identity.
- UI copy that says `Default account` without identifying provider home.
- Account-in-use warning keyed only by auth profile key.
- Any fallback that turns failed resume into fresh session without confirmation.

Keep:

- Existing provider auth profile storage.
- Existing runtime profile storage.
- Existing native import session capability.
- Deprecated `authProfileKey` protocol parsing at one normalization boundary.

## Test Plan

Unit tests:

- Native default home resolves to `ProviderHomeRef`.
- Managed profile resolves to `ProviderHomeRef`.
- Same account in two homes produces two home refs.
- Legacy no-auth agent maps to native default.
- Deprecated `authProfileKey` protocol/storage input maps to managed profile.
- Codex device-code login creates managed home metadata.
- `Import current` records source and target homes.
- Runtime profile account field resolves to provider home.

Integration tests:

- Import native Codex session with source account.
- Import managed Codex session with managed source account.
- Imported session custom settings model-only change keeps provider home.
- Account switch classifies cross-home transition.
- Runtime profile switch classifies cross-home transition.
- Fresh-required transition requires confirmation.

Codex matrix tests:

- Same-home native resume.
- Same-home managed resume.
- Native to managed same account.
- Native to managed different account.
- Managed to managed same account.
- Managed to managed different account.
- Paseo-created thread cross-home.
- Imported CLI rollout cross-home.

UI tests:

- Provider settings distinguishes managed home and native default.
- Add account copy says managed account/home.
- Import current copy says copy current provider login.
- Import sheet shows source account.
- Same email in two homes is distinguishable.
- Custom settings shows current provider home.

## Back Compatibility

Protocol:

- New fields are optional.
- Old fields remain accepted.
- Do not narrow schemas.
- Remove `authProfileKey` from internal models and new writes.
- Keep accepting deprecated `authProfileKey` only at the protocol/storage read
  boundary until the protocol floor allows removal.
- Tag that boundary with `COMPAT(providerHomeRef)`.

Storage:

- No migration file.
- Read-time mapping fills provider home metadata for old agents.
- Future writes include provider home metadata.

Feature gates:

- New UI that requires provider-home metadata should read a
  `server_info.features.*` capability.
- Do not simulate missing provider-home behavior with scattered fallbacks.

## Risks

- Same account across homes can still confuse users if labels are weak.
- Provider auth tokens may not expose stable account ids.
- Cross-home clone may leak context across account boundaries if implemented
  incorrectly.
- Provider session file formats can change.
- Runtime profiles can remain confusing if UI treats them as sessions instead
  of templates.

## Final Decision

Implement Codex first.

The product behavior after this plan:

- Provider-native home stays intact.
- Paseo managed homes are explicit.
- Import session defaults to source continuity.
- Account/runtime switches preserve native session when provider capability
  allows it.
- Fresh native session is explicit and confirmed.
- Same account in different homes is visible and understandable.
- Provider/account/profile/import surfaces use one backend resolver and one UI
  vocabulary.
