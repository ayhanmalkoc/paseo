import {
  buildDaemonWebSocketUrl as buildSharedDaemonWebSocketUrl,
  buildRelayWebSocketUrl as buildSharedRelayWebSocketUrl,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  parseHostPort,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
  shouldUseTlsForDefaultHostedRelay,
  type WebSocketUrlOptions,
  type HostPortParts,
} from "@server/shared/daemon-endpoints";
import { isWeb } from "@/constants/platform";

export { decodeOfferFragmentPayload } from "@server/shared/connection-offer";

export type { HostPortParts };

export {
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  parseHostPort,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
  shouldUseTlsForDefaultHostedRelay,
};

function shouldForceDirectDaemonTlsOnWeb(): boolean {
  if (!isWeb) {
    return false;
  }
  const protocol = (globalThis as { location?: { protocol?: string } }).location?.protocol;
  return protocol === "https:";
}

export function buildDaemonWebSocketUrl(endpoint: string, opts: WebSocketUrlOptions): string {
  return buildSharedDaemonWebSocketUrl(endpoint, {
    ...opts,
    useTls: opts.useTls || shouldForceDirectDaemonTlsOnWeb(),
  });
}

export function buildRelayWebSocketUrl(params: {
  endpoint: string;
  serverId: string;
  useTls: boolean;
}): string {
  return buildSharedRelayWebSocketUrl({ ...params, role: "client" });
}
