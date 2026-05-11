export interface CodexAppServerInitializeParams {
  clientInfo: { name: string; title: string; version: string };
  capabilities: { experimentalApi: true };
}

export function buildCodexAppServerInitializeParams(): CodexAppServerInitializeParams {
  return {
    clientInfo: {
      name: "paseo",
      title: "Paseo",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}
