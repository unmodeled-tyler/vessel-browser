import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDefinition } from "./definitions";

const MCP_PREFIX = "vessel_";

/**
 * Convert tool definitions to Anthropic.Tool[] for the internal AI agent.
 * Filters out mcpOnly tools.
 */
export function toAnthropicTools(defs: ToolDefinition[]): Anthropic.Tool[] {
  return defs
    .filter((d) => !d.mcpOnly)
    .map((d) => {
      let inputSchema: Anthropic.Tool["input_schema"];

      if (d.inputSchema) {
        const jsonSchema = z.toJSONSchema(z.object(d.inputSchema)) as Record<
          string,
          unknown
        >;
        // Strip fields the Anthropic SDK doesn't need
        delete jsonSchema.$schema;
        delete jsonSchema.additionalProperties;
        inputSchema = jsonSchema as Anthropic.Tool["input_schema"];
      } else {
        inputSchema = {
          type: "object" as const,
          properties: {},
        };
      }

      return {
        name: d.name,
        description: d.description,
        input_schema: inputSchema,
      };
    });
}

/**
 * Build a lookup map from base tool name to its definition.
 * Useful for MCP server to reference canonical descriptions/titles.
 */
export function buildToolDefMap(
  defs: ToolDefinition[],
): Record<string, ToolDefinition> {
  return Object.fromEntries(defs.map((d) => [d.name, d]));
}

/**
 * Get the MCP tool name with the vessel_ prefix.
 */
export function mcpName(baseName: string): string {
  return `${MCP_PREFIX}${baseName}`;
}
