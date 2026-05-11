# Provider Account And Runtime Profiles

Status: canonical current-state document for the provider account, runtime
profile, import session, and session-continuity layer.

This document replaces the older split plans for provider auth profiles,
provider auth onboarding, provider-home alignment, runtime profiles, and Codex
cross-account session clone. Keep this file as the single source of truth for
this layer.

## Product Model

Paseo separates four concepts:

- Provider: the executable/runtime family, such as Codex, Claude, or OpenCode.
- Account: a credential record plus the provider home that owns that
  credential.
- Runtime profile: a reusable preset for provider, account, model, mode,
  feature values, instructions, MCP servers, and session behavior.
- Agent snapshot: the launch-time resolved copy used by an agent. Existing
  agents do not silently follow later runtime profile edits.

The user mental model is:

- Same Paseo agent.
- Same conversation when possible.
- New selected runtime profile/account/model settings after an explicit switch.

The default session behavior is `continue`. `fresh` is explicit.

## Canonical Data Model

New code uses these canonical fields:

- `providerHomeRef`: the provider home identity used to launch/resume a provider.
- `accountKey`: the selected managed account key in profile/editor surfaces.
- `runtimeProfileId`: the selected reusable runtime profile.
- `sessionBehavior`: `continue` or `fresh`.

`providerHomeRef` is the boundary-safe account identity. For Codex this decides
the `CODEX_HOME` used by the app-server process.

`authProfileKey` is not part of the product model. It is accepted only at
protocol/storage compatibility boundaries and immediately normalized to
`providerHomeRef`/`accountKey`.

## Implemented Scope

Codex is the implemented provider for account/profile continuity.

Implemented surfaces:

- Provider settings can list, refresh, default, remove, and import current Codex
  accounts.
- Codex account onboarding supports ChatGPT device-code login through the Codex
  app-server flow.
- New-agent custom settings can select an account.
- Runtime profile settings can create/edit/delete profiles with provider,
  account, model, mode, thinking, concurrency, session behavior, instructions,
  feature values, environment, and MCP server settings.
- Feature values use provider-defined structured controls. Environment and MCP
  server settings stay as JSON because they are open-ended power-user
  configuration.
- Active agents can switch account/runtime profile through an explicit restart
  confirmation.
- Import session sheet can import native provider sessions with source account
  or an explicitly selected account.
- CLI import supports selected account through `providerHomeRef`.
- Persisted/resumed agents carry resolved `providerHomeRef`.

## Codex Session Continuity

Codex native continuity depends on the rollout file being visible in the target
`CODEX_HOME`.

Implemented behavior:

- Source account import resumes from the native/source provider home.
- Different selected account copies the Codex rollout file into the selected
  managed account home before launch.
- If the target rollout is an older prefix of the source rollout, Paseo
  fast-forwards it.
- If the target rollout is newer, Paseo uses the target copy.
- If source and target rollout histories diverge, Paseo refuses to silently lose
  context.

Only the per-thread rollout file is copied. Auth files, token files, config,
cache, and unrelated sessions are not copied.

## Current UI Surfaces

Settings:

- Add provider installs/configures provider definitions.
- Accounts manages provider accounts for the selected provider.
- Runtime profiles manages reusable launch presets.

New agent/custom settings:

- Provider/model/mode selectors.
- Account selector.
- Runtime profile selector.
- Runtime profile selection can override custom account/model controls.

Import session:

- `Source account` means use the provider home that owns the native session.
- Explicit account selection means continue through that account when supported.
- Codex explicit account selection copies/fast-forwards the rollout file first.

Active agent:

- Account switch restarts the same Paseo agent with a selected provider home.
- Runtime profile switch restarts the same Paseo agent with the selected
  profile snapshot.
- Confirmation copy says the same conversation is kept when possible.

## Provider Support Boundaries

| Provider | Account surfaces                                                                           | Native import                                                                         | Cross-account continuity                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | Enabled. Listing/import/default/remove and ChatGPT device-code onboarding are implemented. | Reads Codex native sessions from the selected source provider home.                   | Implemented by copying/fast-forwarding the target rollout file before resume.                                                                                        |
| Claude   | Disabled. No managed account adapter exists yet.                                           | Reads native Claude project sessions from the native default Claude config directory. | Not enabled. Claude session files are tied to the native Claude config/project layout and need provider-specific design before managed account switching is exposed. |
| OpenCode | Disabled. No managed account adapter exists yet.                                           | Reads OpenCode sessions from the OpenCode storage root used by the provider wrapper.  | Not enabled. OpenCode storage is provider-managed and the account boundary is not represented by Paseo yet.                                                          |

Server capability payloads expose provider-specific support lists:

- `providerAuthProfileProviders`
- `providerAccountOnboardingProviders`

Current value is Codex-only. Old daemons that only send the global boolean are
still accepted by the client for protocol compatibility.

Unsupported providers should not pretend to support managed account continuity.
They should either use native default provider homes or surface a clear
unsupported state.

## Compatibility

Protocol remains backward-compatible.

Accepted compatibility inputs:

- Old clients may send `authProfileKey` in import/restart messages.
- Old stored agents may contain `config.authProfileKey`.
- Old import-session source descriptors may contain `source.authProfileKey`.

Compatibility behavior:

- Parse old `authProfileKey`.
- Convert it to `providerHomeRef`/`accountKey` at the boundary.
- Do not store or pass `authProfileKey` through new internal code.
- Continue emitting optional `authProfileKey` where old clients parse snapshots
  or import sources.

Every remaining `authProfileKey` reference should be either protocol/storage
compat or a compat test.

## Remaining Product Work

Provider-specific follow-up:

- Add a Claude managed-account adapter only after deciding the native home
  boundary and resume/clone safety.
- Add an OpenCode managed-account adapter only after deciding how OpenCode
  storage maps to accounts.
- Add provider-specific continuity tests before enabling either provider in
  `providerAuthProfileProviders`.

UI follow-up:

- Keep feature values structured and provider-defined.
- Keep environment and MCP server settings as JSON unless a future provider
  exposes a narrower schema.
- Keep Add provider, Add account, and Runtime profile copy visually distinct.

Testing follow-up:

- Add provider-specific continuity tests before enabling account surfaces beyond
  Codex.
- Keep Codex regression coverage for source import, explicit account import,
  profile switch, account switch, rollout copy, fast-forward, and divergent
  rollout refusal.

## Definition Of Done

This layer is healthy when:

- New product code uses `providerHomeRef`/`accountKey`, not `authProfileKey`.
- Import session, runtime profile switch, and account switch follow the same
  mental model.
- Existing stored agents and old clients still parse.
- Provider-specific continuity is explicit, not assumed.
