import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

/**
 * True when a tool reported failure without throwing. Both the top-level `isError`
 * flag and the details-level flag count: aggregating tools set the latter.
 */
export function toolResultHasError(result: AgentToolResult): boolean {
	if (isRecord(result) && result.isError === true) return true;
	return isRecord(result.details) && result.details.isError === true;
}

/**
 * Resolve a live tool by name for in-process dispatch (eval bridge, schema commit
 * queue). Prefers the bridge-specific lookup so a session may expose a different
 * tool set to programmatic callers than to the model.
 */
export function getSessionTool(session: ToolSession, name: string, caller?: string): AgentTool {
	const tool = session.getToolForEvalBridge
		? session.getToolForEvalBridge(name)
		: (session.getToolByName?.(name) ?? session.toolRegistry?.get(name));
	if (!tool) throw new ToolError(`Unknown tool${caller ? ` from ${caller}` : ""}: ${name}`);
	return tool;
}
