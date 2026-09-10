import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { toolResultHasError } from "../tools/tool-dispatch";
import { isSchemaEnabled, SchemaRuntime } from "./state";
import type { SchemaObservation } from "./types";

const kSchemaWrapped = Symbol.for("omp.schema.wrapped");

/** Tools that change nothing outside the agent's own head, so they never enter the timeline. */
const DELIBERATION_TOOLS = new Set(["think", "todo", "yield", "goal", "ask"]);

/** Flatten a tool result into the observation the world model is asked to predict. */
export function observationOf(result: AgentToolResult): SchemaObservation {
	const text = result.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text)
		.join("");
	return { ok: !toolResultHasError(result), text, details: result.details };
}

function isSchemaTool(name: string): boolean {
	return name.startsWith("schema_");
}

/**
 * Put every tool inside the Schema control loop.
 *
 * Two invariants come from this wrapper. First, `record`: every real interaction is
 * appended to the append-only timeline, so certification always runs against the
 * complete history rather than against what survived the context window. Second, the
 * commit channel: a tool that changes the world runs only inside `schema_commit`,
 * which carries a prediction for it and stops the rest of the plan on the first
 * mismatch.
 */
export function wrapToolWithSchemaLoop<T extends AgentTool<any, any, any>>(session: ToolSession, tool: T): T {
	if (!isSchemaEnabled(session) || kSchemaWrapped in tool) return tool;
	if (isSchemaTool(tool.name) || DELIBERATION_TOOLS.has(tool.name)) return tool;

	const originalExecute = tool.execute.bind(tool) as T["execute"];

	async function schemaExecute(
		this: unknown,
		id: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		context?: unknown,
	): Promise<AgentToolResult> {
		const runtime = SchemaRuntime.for(session);
		if (runtime.gatedTools().has(tool.name)) runtime.assertCommitChannel(tool.name);
		try {
			const result = (await (originalExecute as (...args: unknown[]) => Promise<AgentToolResult>)(
				id,
				params,
				signal,
				onUpdate,
				context,
			)) as AgentToolResult;
			// Inside a commit the queue records each step together with the projection it
			// promised, so recording here would double-count the transition.
			if (!runtime.committing) await runtime.record(tool.name, params, observationOf(result));
			return result;
		} catch (error) {
			if (!runtime.committing) {
				await runtime
					.record(tool.name, params, {
						ok: false,
						text: error instanceof Error ? error.message : String(error),
					})
					.catch((recordError: unknown) => {
						logger.warn("Schema timeline could not record a tool failure", {
							tool: tool.name,
							error: recordError instanceof Error ? recordError.message : String(recordError),
						});
					});
			}
			throw error;
		}
	}

	return Object.defineProperties(tool, {
		[kSchemaWrapped]: { value: true, enumerable: false, configurable: true },
		execute: { value: schemaExecute, enumerable: false, configurable: true, writable: true },
	});
}
