import http from "node:http";

export interface McpRuntimeState {
  httpServer: http.Server | null;
  authToken: string | null;
}

export const mcpRuntimeState: McpRuntimeState = {
  httpServer: null,
  authToken: null,
};
