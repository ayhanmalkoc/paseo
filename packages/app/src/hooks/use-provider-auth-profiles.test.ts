import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  providerAuthProfilesQueryKey,
  providerAuthProfilesServerQueryKey,
} from "./use-provider-auth-profiles";

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: () => false,
}));

describe("provider auth profile query keys", () => {
  it("supports server-wide invalidation for provider-scoped account caches", async () => {
    const queryClient = new QueryClient();
    const codexKey = providerAuthProfilesQueryKey("server-1", "codex");
    const allProvidersKey = providerAuthProfilesQueryKey("server-1");
    const otherServerKey = providerAuthProfilesQueryKey("server-2", "codex");

    queryClient.setQueryData(codexKey, []);
    queryClient.setQueryData(allProvidersKey, []);
    queryClient.setQueryData(otherServerKey, []);

    await queryClient.invalidateQueries({
      queryKey: providerAuthProfilesServerQueryKey("server-1"),
    });

    expect(queryClient.getQueryState(codexKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(allProvidersKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherServerKey)?.isInvalidated).toBe(false);
  });
});
