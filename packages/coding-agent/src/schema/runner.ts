import { executeJs } from "../eval/js/executor";
import type { ToolSession } from "../tools";
import harnessSource from "./runtime/harness/template.js" with { type: "text" };
import type { AdvanceResult, BacktestReport, PlanReport, SchemaAction, SchemaObservation } from "./types";

const RESULT_SENTINEL = "__SCHEMA_RESULT__";

/** One recorded transition handed to the world model for replay. */
export interface HarnessTransition {
	action: SchemaAction;
	observation: SchemaObservation;
	/** Counts toward coverage: committed or world-changing, within the configured scope. Reads never do. */
	billable?: boolean;
}

interface HarnessRequest {
	op: "backtest" | "plan" | "open" | "advance";
	transitions?: HarnessTransition[];
	action?: SchemaAction;
	observation?: SchemaObservation;
	maxNodes?: number;
	maxDepth?: number;
	/** Search even when the replay is not green. Guided mode only. */
	allowUncertified?: boolean;
}

interface HarnessPayload {
	backtest?: BacktestReport;
	plan?: PlanReport;
	advance?: AdvanceResult;
	fatal?: string;
}

/** Raised when the world model could not be executed at all. */
export class WorldModelRunError extends Error {}

/**
 * JSON is a JS expression except for two line terminators that are legal in JSON
 * strings and illegal in JS source. Escape them so the payload always parses.
 */
function embedJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function extractResult(output: string): unknown {
	const marker = output.lastIndexOf(RESULT_SENTINEL);
	if (marker < 0) return undefined;
	const start = marker + RESULT_SENTINEL.length;
	const lineEnd = output.indexOf("\n", start);
	const payload = lineEnd < 0 ? output.slice(start) : output.slice(start, lineEnd);
	try {
		return JSON.parse(payload) as unknown;
	} catch {
		return undefined;
	}
}

function stripResultLine(output: string): string {
	return output
		.split("\n")
		.filter(line => !line.startsWith(RESULT_SENTINEL))
		.join("\n")
		.trim();
}

/** VM identity for schema work. Kept apart from the agent's own `eval` kernel. */
function schemaKernelId(session: ToolSession): string {
	return `schema:${session.getSessionId?.() ?? "default"}`;
}

async function runHarness(
	session: ToolSession,
	request: HarnessRequest,
	options: { modelSource?: string; reset: boolean; signal?: AbortSignal },
): Promise<{ payload: HarnessPayload; stdout: string }> {
	const preamble = `globalThis.__SCHEMA_REQUEST__ = ${embedJson(request)};`;
	const code = options.modelSource
		? `${preamble}\n${options.modelSource}\n;\n${harnessSource}`
		: `${preamble}\n${harnessSource}`;
	const result = await executeJs(code, {
		session,
		sessionId: schemaKernelId(session),
		kernelOwnerId: session.getSessionId?.() ?? undefined,
		cwd: session.cwd,
		reset: options.reset,
		timeoutMs: session.settings.get("schema.timeoutMs"),
		signal: options.signal,
	});
	const parsed = extractResult(result.output);
	if (parsed === null || typeof parsed !== "object") {
		throw new WorldModelRunError(
			`world_model.js produced no result. Raw output:\n${result.output.slice(0, 2000) || "(empty)"}`,
		);
	}
	const payload = parsed as HarnessPayload;
	if (typeof payload.fatal === "string") {
		throw new WorldModelRunError(`world_model.js crashed: ${payload.fatal}`);
	}
	return { payload, stdout: stripResultLine(result.output) };
}

/**
 * Replay the world model over the complete recorded history.
 *
 * The VM is reset first: a stale `step` left by a previous revision would silently
 * certify a model the agent no longer has.
 */
export async function backtestWorldModel(
	session: ToolSession,
	modelSource: string,
	transitions: HarnessTransition[],
	signal?: AbortSignal,
): Promise<{ report: BacktestReport; stdout: string }> {
	const { payload, stdout } = await runHarness(
		session,
		{ op: "backtest", transitions },
		{ modelSource, reset: true, signal },
	);
	if (!payload.backtest) throw new WorldModelRunError("world_model.js returned no backtest report.");
	return { report: payload.backtest, stdout };
}

/** Search inside the model. Costs no real actions, so it is the cheap place to be wrong. */
export async function planInWorldModel(
	session: ToolSession,
	modelSource: string,
	transitions: HarnessTransition[],
	limits: { maxNodes: number; maxDepth: number; allowUncertified?: boolean },
	signal?: AbortSignal,
): Promise<{ report: BacktestReport; plan: PlanReport; stdout: string }> {
	const { payload, stdout } = await runHarness(
		session,
		{
			op: "plan",
			transitions,
			maxNodes: limits.maxNodes,
			maxDepth: limits.maxDepth,
			allowUncertified: limits.allowUncertified,
		},
		{ modelSource, reset: true, signal },
	);
	if (!payload.backtest || !payload.plan) throw new WorldModelRunError("world_model.js returned no plan report.");
	return { report: payload.backtest, plan: payload.plan, stdout };
}

/**
 * Replay history once and leave the model live in the VM, so each committed step can
 * be checked against its prediction without replaying everything again.
 */
export async function openLiveModel(
	session: ToolSession,
	modelSource: string,
	transitions: HarnessTransition[],
	signal?: AbortSignal,
): Promise<BacktestReport> {
	const { payload } = await runHarness(session, { op: "open", transitions }, { modelSource, reset: true, signal });
	if (!payload.backtest) throw new WorldModelRunError("world_model.js returned no backtest report.");
	return payload.backtest;
}

/**
 * Advance the live model by one real transition and compare its projection with what
 * actually happened. Returns `stale` when the VM lost the live state, in which case
 * the caller falls back to a full replay.
 */
export async function advanceLiveModel(
	session: ToolSession,
	action: SchemaAction,
	observation: SchemaObservation,
	signal?: AbortSignal,
): Promise<AdvanceResult> {
	const { payload } = await runHarness(session, { op: "advance", action, observation }, { reset: false, signal });
	if (!payload.advance) throw new WorldModelRunError("world_model.js returned no step verdict.");
	return payload.advance;
}
