import { TOOL_DEFINITIONS } from "../tools/definitions";
import { toAnthropicTools } from "../tools/adapters";

export const AGENT_TOOLS = toAnthropicTools(TOOL_DEFINITIONS);
