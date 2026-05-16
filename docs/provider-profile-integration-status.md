# Provider/Profile Integration Status

Temporary investigation note. Delete this document once the provider/profile
adapter rollout is complete and the stable decisions have moved into the
canonical provider docs.

## Why this exists

The Codex provider now has the deepest account/profile/native-config
integration in Paseo. The visible UI is broader than Codex, though: the app can
list multiple providers and runtime profiles are modeled as a provider-agnostic
launch preset. This document captures which parts are genuinely generic today
and which parts are still Codex-specific.

## Current State

Paseo has two different levels of provider support:

- General provider support: the provider can be listed and launched as an
  agent.
- Managed account/profile support: the provider participates in Paseo's account
  surfaces, provider default account, native config materialization, usage
  refresh, MCP controls, hooks, and account-aware session continuity.

Codex currently supports both levels. Other providers mostly support the first
level and still need provider-specific adapters before they can support the
second level.

## Surface Map

| Surface                           | Current status                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Provider list                     | Generic. Claude, Codex, Copilot, OpenCode, Pi, Mock, and custom/ACP providers can appear.                                               |
| Provider launch                   | Generic. Non-Codex providers can be launched through their provider clients.                                                            |
| Runtime profile model             | Mostly generic. Profiles store provider, model, mode, thinking, feature values, env, MCP JSON, account selection, and session behavior. |
| Runtime profile account selection | Codex-backed in practice. Provider default and managed account resolution depend on Codex account support today.                        |
| Provider account list             | Codex-backed. Listing/import/default/remove/refresh are implemented through the Codex account adapter.                                  |
| Account onboarding                | Codex only. Device-code login is implemented through the Codex app-server flow.                                                         |
| Usage refresh                     | Codex only. Usage is refreshed from the Codex provider API/app-server path.                                                             |
| Native provider config            | Codex only. The provider config service currently supports Codex config and hooks.                                                      |
| MCP controls in settings          | Codex-backed. The UI edits provider-native Codex config instead of a separate Paseo MCP registry.                                       |
| Hooks materialization             | Codex only. `hooks.json` is synced with provider config and materialized into managed Codex homes.                                      |
| Import session list               | Provider-generic for importable providers: Claude, Codex, and OpenCode.                                                                 |
| Import with selected account      | Codex-specific for account-aware native session continuity.                                                                             |
| Cross-account continuity          | Codex-specific. Rollout/session continuity is implemented around Codex native session files.                                            |
| Gemini provider launch            | Enabled through Gemini CLI ACP. Managed account/native-config integration is not implemented yet.                                       |

## Codex Integration Baseline

Codex is the reference implementation for the managed provider model:

- Provider-global native config lives under the managed Paseo provider config
  path.
- Managed account homes receive materialized provider config at launch/sync
  time.
- MCP enable/disable/edit/remove writes the Codex-native config rather than a
  second Paseo registry.
- Hooks are synced with the provider config and path-rewritten into managed
  account homes.
- Provider default account is resolved at launch time.
- Runtime profiles can refer to provider default account or explicit managed
  accounts.
- Import session can continue native Codex sessions through selected accounts
  when possible.

This is the model to reuse conceptually for other providers, but not by forcing
Codex filesystem assumptions onto them.

## Known Gaps

### Claude

Claude can launch as a provider, and Claude sessions can appear in import
flows, but managed account/profile integration is not implemented yet.

Missing pieces:

- Claude account/auth adapter.
- Claude account discovery and default account semantics.
- Claude usage refresh, if a reliable provider-native source exists.
- Claude native config adapter for any MCP/config/hooks-equivalent surfaces.
- Account-aware import/session continuity design.
- Runtime profile account selection backed by real Claude managed accounts.

### OpenCode

OpenCode launches under Paseo-managed XDG roots at
`$PASEO_HOME/providers/opencode/{config,data,state}`. On first use, Paseo seeds
missing OpenCode config/data entries from the native XDG locations, then keeps
the managed roots independent. OpenCode sessions can appear in import flows, but
managed account/profile integration is not implemented yet.

Missing pieces:

- OpenCode account/auth adapter.
- OpenCode account discovery and default account semantics.
- OpenCode usage refresh, if available.
- OpenCode native config UI/editor for MCP/config equivalents.
- Account-aware import/session continuity design.
- Runtime profile account selection backed by real OpenCode managed accounts.

### ACP/Custom Providers

ACP/custom providers launch through provider definitions, but they do not have a
managed account/native-config integration model today.

Missing pieces depend on each provider:

- Whether the provider has native accounts at all.
- Whether a stable native config path exists.
- Whether MCP or plugin configuration is provider-native or passed through
  runtime options.
- Whether session continuity can be mapped to provider-native history.

### Gemini

Gemini is available as a built-in ACP-backed provider using the local Gemini CLI
binary with `gemini --acp`. It uses Gemini CLI's native authentication and
configuration by default.

Missing pieces:

- Gemini account/auth adapter around `GEMINI_CLI_HOME` and native
  `~/.gemini` files.
- Gemini native config adapter for `settings.json`, especially `mcpServers`.
- Gemini usage/limit refresh, if a reliable native/API source exists.
- Import/session continuity design for Gemini CLI session history.

## Implementation Direction

Do not reintroduce a central MCP registry. The current direction is:

1. Keep runtime profiles provider-agnostic as launch presets.
2. Keep provider-owned live/native data in provider adapters.
3. Resolve profile/account/provider config at launch time.
4. Let each provider adapter translate Paseo's generic launch model into the
   provider's native shape.
5. Only expose account/config controls when the server advertises that the
   provider supports them.

For new providers, implement a provider-specific adapter first, then expose the
surface:

1. Account/auth adapter.
2. Native config adapter, if the provider has a meaningful native config.
3. Usage adapter, if the provider exposes reliable usage data.
4. Import/session continuity adapter.
5. UI enablement through server feature provider lists.

## Current Feature Boundaries

The server advertises feature provider lists for these surfaces:

- Provider auth/profile support.
- Account onboarding support.
- Provider native config support.

The app should treat those lists as the boundary. A generic provider being
launchable does not mean it supports managed accounts, provider-native config,
usage refresh, or account-aware import continuity.

## Next Work Candidates

Recommended order:

1. Confirm Claude native auth/config/session layout.
2. Design Claude managed account adapter only after the native boundaries are
   clear.
3. Confirm OpenCode native storage/config/session layout.
4. Design OpenCode managed account adapter only after the native boundaries are
   clear.
5. Keep Codex as the reference behavior while avoiding Codex-specific path
   assumptions in generic types.
