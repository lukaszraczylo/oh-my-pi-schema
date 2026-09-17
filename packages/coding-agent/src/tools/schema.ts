import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { rankExperiments } from "../schema/experiment";
import { observationOf } from "../schema/gate";
import { advanceLiveModel, openLiveModel, planInWorldModel } from "../schema/runner";
import { isSchemaEnabled, SchemaRuntime } from "../schema/state";
import { countEpicycles } from "../schema/store";
import type { AdvanceResult, BacktestReport, Hypothesis, PlanReport, SchemaAction } from "../schema/types";
import schemaBacktestDescription from "../prompts/tools/schema-backtest.md" with { type: "text" };
import schemaCommitDescription from "../prompts/tools/schema-commit.md" with { type: "text" };
import schemaExperimentDescription from "../prompts/tools/schema-experiment.md" with { type: "text" };
import schemaModelDescription from "../prompts/tools/schema-model.md" with { type: "text" };
import schemaPlanDescription from "../prompts/tools/schema-plan.md" with { type: "text" };
import type { ToolSession } from ".";
import { getSessionTool } from "./tool-dispatch";
import { ToolError, throwIfAborted } from "./tool-errors";

const TIMELINE_TAIL_DEFAULT = 20;

const schemaModelSchema = type({
	"action?": type("'status' | 'read' | 'write' | 'notes' | 'timeline'").describe(
		"what to do with the world model (default: status)",
	),
	"source?": type("string").describe("replacement world_model.js source (write)"),
	"note?": type("string").describe("one line on what changed in this revision and why (write)"),
	"notes?": type("string").describe("replacement notes.md text (notes)"),
	"limit?": type("number").describe("how many timeline entries to show (timeline)"),
});

const schemaBacktestSchema = type({});

const schemaPlanSchema = type({
	"maxNodes?": type("number").describe("node budget for the search"),
	"maxDepth?": type("number").describe("longest action sequence to consider"),
});

const commitStepSchema = type({
	tool: type("string").describe("tool to run"),
	args: type("object").describe("arguments for the tool"),
	"predict?": type("string").describe("projection you expect this step's observation to produce"),
});

const schemaCommitSchema = type({
	rationale: type("string").describe("why this queue, in one line"),
	steps: commitStepSchema.array().describe("ordered actions to execute against the world"),
});

const hypothesisSchema = type({
	id: type("string").describe("short identifier"),
	claim: type("string").describe("what this hypothesis asserts about the mechanism"),
	predicts: type("object").describe("candidate action label to the projection this hypothesis predicts"),
});

const schemaExperimentSchema = type({
	hypotheses: hypothesisSchema.array().describe("the explanations still standing"),
	"candidates?": type("string").array().describe("candidate actions to rank (defaults to every predicted action)"),
});

export type SchemaModelParams = typeof schemaModelSchema.infer;
export type SchemaBacktestParams = typeof schemaBacktestSchema.infer;
export type SchemaPlanParams = typeof schemaPlanSchema.infer;
export type SchemaCommitParams = typeof schemaCommitSchema.infer;
export type SchemaExperimentParams = typeof schemaExperimentSchema.infer;

export interface SchemaModelDetails {
	action: string;
	revision?: number;
	epicycles?: number;
	timelineLength?: number;
}

export interface SchemaBacktestDetails {
	report: BacktestReport;
}

export interface SchemaPlanDetails {
	plan: PlanReport;
}

export interface SchemaCommitStepOutcome {
	index: number;
	tool: string;
	executed: boolean;
	match?: boolean;
	predicted?: string;
	observed?: string;
	error?: string;
}

export interface SchemaCommitDetails {
	executed: number;
	requested: number;
	voided: boolean;
	steps: SchemaCommitStepOutcome[];
}

export interface SchemaExperimentDetails {
	best?: string;
	rankings: number;
}

function text(body: string): AgentToolResult["content"] {
	return [{ type: "text", text: body }];
}

function requireSchemaMode(session: ToolSession): SchemaRuntime {
	if (!isSchemaEnabled(session)) {
		throw new ToolError(
			"Schema mode is off for this session. Set `schema.mode` to `strict` or `guided` (with `schema.enabled` true) to use the schema tools.",
		);
	}
	return SchemaRuntime.for(session);
}

/** Render a certification verdict the way the model needs to read it: counts first, then the disagreements. */
export function formatBacktest(report: BacktestReport): string {
	const lines: string[] = [];
	lines.push(
		`backtest [all transitions]: ${report.matched}/${report.checked} transitions fully correct; ` +
			`${report.mismatches.length} mismatch(es), ${report.skipped} skipped of ${report.total} recorded.`,
	);
	lines.push(
		`coverage ${report.billableChecked}/${report.billable} world-changing (${(report.coverage * 100).toFixed(0)}%) · ` +
			`state keys [${report.stateKeys.join(", ")}] · ` +
			`is_goal ${report.goalReached ? "true" : "false"} · ${report.green ? "GREEN" : "NOT CERTIFIED"}`,
	);
	if (report.error) lines.push(`error: ${report.error}`);
	for (const mismatch of report.mismatches) {
		lines.push(
			`\nmismatch at timeline entry ${mismatch.seq} (${mismatch.tool}):\n` +
				`  predicted: ${mismatch.predicted}\n` +
				`  observed:  ${mismatch.observed}`,
		);
	}
	return lines.join("\n");
}

/** Read, revise, and inspect the executable theory of the task. */
export class SchemaModelTool implements AgentTool<typeof schemaModelSchema, SchemaModelDetails> {
	readonly name = "schema_model";
	readonly approval = (args: unknown): "read" | "write" =>
		args !== null && typeof args === "object" && ("source" in args || "notes" in args) ? "write" : "read";
	readonly label = "World Model";
	readonly description = schemaModelDescription;
	readonly parameters = schemaModelSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Read or revise world_model.js, the executable theory of this task";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SchemaModelTool | null {
		return isSchemaEnabled(session) ? new SchemaModelTool(session) : null;
	}

	async execute(
		_id: string,
		params: SchemaModelParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SchemaModelDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SchemaModelDetails>> {
		const runtime = requireSchemaMode(this.session);
		throwIfAborted(signal);
		const action = params.action ?? "status";
		const store = runtime.store;

		if (action === "write") {
			if (!params.source?.trim()) throw new ToolError("`source` is required to write the world model.");
			if (!params.note?.trim())
				throw new ToolError("`note` is required: say what changed in this revision and why.");
			const revision = await store.writeModel(params.source, params.note.trim());
			runtime.clearVoidedPlan();
			return {
				content: text(
					`world_model.js revision ${revision.version} written (${revision.bytes} bytes). ` +
						"The previous certification no longer applies — run `schema_backtest`.",
				),
				details: { action, revision: revision.version },
			};
		}

		if (action === "notes") {
			if (params.notes !== undefined) {
				await store.writeNotes(params.notes);
				return { content: text("notes.md saved."), details: { action } };
			}
			const notes = await store.readNotes();
			return { content: text(notes || "notes.md is empty."), details: { action } };
		}

		if (action === "read") {
			const { source, seeded, upgraded } = await store.readModel();
			const notes = await store.readNotes();
			const header = seeded
				? "world_model.js did not exist; the scaffold below was created.\n\n"
				: upgraded
					? "world_model.js was the untouched earlier seed; it was upgraded to the current seed below.\n\n"
					: "";
			return {
				content: text(`${header}--- world_model.js ---\n${source}\n\n--- notes.md ---\n${notes || "(empty)"}`),
				details: { action },
			};
		}

		if (action === "timeline") {
			const entries = await runtime.timeline.entries();
			const limit = Math.max(1, Math.trunc(params.limit ?? TIMELINE_TAIL_DEFAULT));
			const tail = entries.slice(-limit);
			const rendered = tail
				.map(entry => {
					const flag = entry.surprise ? " SURPRISE" : "";
					const status = entry.observation.ok ? "ok" : "error";
					const head = entry.observation.text.split("\n", 1)[0]?.slice(0, 160) ?? "";
					return `#${entry.seq} ${entry.tool} (${status})${flag} :: ${head}`;
				})
				.join("\n");
			return {
				content: text(
					`${entries.length} recorded transition(s); showing the last ${tail.length}.\n${rendered || "(empty)"}`,
				),
				details: { action, timelineLength: entries.length },
			};
		}

		const ledger = await store.readLedger();
		const certification = await runtime.certification();
		const epicycles = countEpicycles(ledger.revisions);
		const timelineLength = await runtime.timeline.length();
		const lines = [
			`world model: ${store.paths.worldModel}`,
			`revisions: ${ledger.revisions.length}${ledger.revisions.at(-1) ? ` · last: ${ledger.revisions.at(-1)?.note}` : ""}`,
			`timeline: ${timelineLength} recorded transition(s) at ${store.paths.timeline}`,
			certification
				? `certification: ${formatBacktest(certification.report).split("\n", 2).join(" | ")}`
				: "certification: stale or never run — run `schema_backtest`.",
			`hypotheses on record: ${ledger.hypotheses.length}`,
		];
		if (runtime.voidedPlan) lines.push(`voided plan: ${runtime.voidedPlan}`);
		if (epicycles >= this.session.settings.get("schema.epicycleThreshold")) {
			lines.push(
				`epicycles: ${epicycles} consecutive revisions patched rules without changing the state representation ` +
					"while the backtest stayed red. Change what the state is made of, not the rule.",
			);
		} else {
			lines.push(`epicycles: ${epicycles}`);
		}
		return { content: text(lines.join("\n")), details: { action: "status", epicycles, timelineLength } };
	}
}

/** Certify the world model against the complete recorded history. */
export class SchemaBacktestTool implements AgentTool<typeof schemaBacktestSchema, SchemaBacktestDetails> {
	readonly name = "schema_backtest";
	readonly approval = "read" as const;
	readonly label = "Backtest";
	readonly description = schemaBacktestDescription;
	readonly parameters = schemaBacktestSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Replay the world model over every recorded transition";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SchemaBacktestTool | null {
		return isSchemaEnabled(session) ? new SchemaBacktestTool(session) : null;
	}

	async execute(
		_id: string,
		_params: SchemaBacktestParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SchemaBacktestDetails>> {
		const runtime = requireSchemaMode(this.session);
		throwIfAborted(signal);
		const report = await runtime.certify(signal);
		return { content: text(formatBacktest(report)), details: { report } };
	}
}

/** Search inside the certified model. Costs no real actions. */
export class SchemaPlanTool implements AgentTool<typeof schemaPlanSchema, SchemaPlanDetails> {
	readonly name = "schema_plan";
	readonly approval = "read" as const;
	readonly label = "Plan In Model";
	readonly description = schemaPlanDescription;
	readonly parameters = schemaPlanSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Breadth-first search inside the certified world model";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SchemaPlanTool | null {
		return isSchemaEnabled(session) ? new SchemaPlanTool(session) : null;
	}

	async execute(
		_id: string,
		params: SchemaPlanParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SchemaPlanDetails>> {
		const runtime = requireSchemaMode(this.session);
		throwIfAborted(signal);
		const { warnings } = await runtime.requireCertification(signal);
		const { source } = await runtime.store.readModel();
		const transitions = await runtime.harnessTransitions();
		const limits = {
			maxNodes: Math.max(1, Math.trunc(params.maxNodes ?? this.session.settings.get("schema.maxSearchNodes"))),
			maxDepth: Math.max(1, Math.trunc(params.maxDepth ?? this.session.settings.get("schema.maxPlanDepth"))),
			allowUncertified: runtime.mode === "guided",
		};
		const { plan } = await planInWorldModel(this.session, source, transitions, limits, signal);
		if (plan.error) throw new ToolError(plan.error);
		const header = plan.found
			? `BFS: goal in ${plan.actions.length} step(s); expanded ${plan.expanded} nodes, ${plan.distinct} distinct states.`
			: `BFS: no path to is_goal; expanded ${plan.expanded} nodes, ${plan.distinct} distinct states` +
				`${plan.exhausted ? " (node budget exhausted)" : " (search space exhausted)"}.`;
		const body = plan.found
			? `${header}\n${JSON.stringify(plan.actions, null, "\t")}`
			: `${header}\nSearch is only complete relative to this model. If the goal is genuinely reachable, ` +
				"the missing piece is in the representation: an object, a state variable, or a transition you have not encoded.";
		const advisory = warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";
		return { content: text(body + advisory), details: { plan } };
	}
}

/** How one committed step was checked. */
export interface StepJudgement {
	/** The prediction that was checked, if any. */
	predicted?: string;
	match?: boolean;
	/** Why the step counts as a surprise. Undefined when reality agreed or nothing was predicted. */
	surprise?: string;
	notices: string[];
}

/** The first non-empty line of a tool's output, for surprise messages. */
function firstLine(text: string): string {
	return (text.split("\n").find(line => line.trim() !== "") ?? "").trim().slice(0, 200);
}

/**
 * Decide what a committed step was checked against. world_model.js is the authority when
 * it predicts. When it declines, the step's own `predict` is checked instead, so a model
 * that is still thin can take part in the loop. A disagreement between the two is advice,
 * not a failure: only reality voids a plan. A step whose tool failed is a surprise unless a
 * prediction anticipated the failure, and a model that could not run judges nothing.
 */
export function judgeStep(
	index: number,
	step: { tool: string; predict?: string },
	verdict: AdvanceResult,
	observation: { ok: boolean; text: string },
): StepJudgement {
	const label = `step ${index} (${step.tool})`;
	const failure = observation.ok ? undefined : `${label} failed: ${firstLine(observation.text)}`;
	if (verdict.stale) {
		const reason = verdict.error ? ` (${verdict.error})` : "";
		return {
			surprise: failure,
			notices: [`${label}: world_model.js could not be run for this step${reason}, so no prediction was checked.`],
		};
	}
	if (verdict.skipped !== true && verdict.predicted !== undefined) {
		const disagrees = step.predict !== undefined && step.predict !== verdict.predicted;
		return {
			predicted: verdict.predicted,
			match: verdict.match === true,
			surprise:
				verdict.match === true
					? undefined
					: `${label} mispredicted: world_model.js expected "${verdict.predicted}", observed "${verdict.observed}"`,
			notices: disagrees
				? [
						`${label}: you declared "${step.predict}" but world_model.js predicts "${verdict.predicted}"; ` +
							"the model's prediction was checked. If yours is right, update step().",
					]
				: [],
		};
	}
	if (step.predict !== undefined && verdict.observed !== undefined) {
		const match = verdict.observed === step.predict;
		if (!match) {
			return {
				predicted: step.predict,
				match,
				surprise: `${label} mispredicted: your inline prediction was "${step.predict}", observed "${verdict.observed}"`,
				notices: [],
			};
		}
		return {
			predicted: step.predict,
			match,
			notices: [
				`${label}: inline prediction "${step.predict}" matched, but world_model.js declined to predict it — ` +
					"encode it in step() so certification covers it.",
			],
		};
	}
	return { surprise: failure, notices: [] };
}

/** The predicted channel from thinking to action; in strict mode, the only one. */
export class SchemaCommitTool implements AgentTool<typeof schemaCommitSchema, SchemaCommitDetails> {
	readonly name = "schema_commit";
	readonly approval = "write" as const;
	readonly label = "Commit Actions";
	readonly description = schemaCommitDescription;
	readonly parameters = schemaCommitSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Execute a predicted plan against the world, stopping on the first surprise";
	/** Runs alone: another tool call in the same turn could otherwise slip past the open gate or the timeline. */
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SchemaCommitTool | null {
		return isSchemaEnabled(session) ? new SchemaCommitTool(session) : null;
	}

	async execute(
		id: string,
		params: SchemaCommitParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SchemaCommitDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<SchemaCommitDetails>> {
		const runtime = requireSchemaMode(this.session);
		throwIfAborted(signal);
		if (params.steps.length === 0) throw new ToolError("`steps` is empty: a commit must carry at least one action.");
		const { warnings } = await runtime.requireCertification(signal);
		const guided = runtime.mode === "guided";

		const { source } = await runtime.store.readModel();
		await openLiveModel(this.session, source, await runtime.harnessTransitions(), signal);

		const outcomes: SchemaCommitStepOutcome[] = [];
		const notices: string[] = [...warnings];
		const surprises: string[] = [];
		let voided = false;
		let liveModel = true;

		await runtime.withCommitChannel(async () => {
			for (const [index, step] of params.steps.entries()) {
				throwIfAborted(signal);
				if (step.tool.startsWith("schema_")) {
					throw new ToolError(
						`Step ${index} names \`${step.tool}\`. Deliberation tools change nothing and never belong in a commit queue.`,
					);
				}
				if (step.tool === "checkpoint" || step.tool === "rewind") {
					throw new ToolError(
						`\`${step.tool}\` is recognized only as a direct tool call; a committed step would report success without taking effect.`,
					);
				}
				const tool = getSessionTool(this.session, step.tool, "schema_commit");
				const callId = `${id}-step-${index}`;
				const validated = validateToolArguments(tool, {
					type: "toolCall",
					id: callId,
					name: step.tool,
					arguments: step.args as Record<string, unknown>,
				});
				let observation;
				try {
					const result = await tool.execute(
						callId,
						validated,
						signal,
						undefined,
						context ?? this.session.getToolContext?.(),
					);
					observation = observationOf(result);
				} catch (error) {
					observation = { ok: false, text: error instanceof Error ? error.message : String(error) };
				}

				const seq = await runtime.timeline.length();
				const action: SchemaAction = { run: runtime.runId, index: seq, tool: step.tool, args: validated };
				const verdict: AdvanceResult = liveModel
					? await this.#checkStep(runtime, source, action, observation, signal)
					: { stale: true };
				// A model that cannot run is not retried for the rest of the queue: every retry is a
				// full replay, and the answer does not change within one commit.
				if (verdict.stale) liveModel = false;
				const judgement = judgeStep(index, step, verdict, observation);
				notices.push(...judgement.notices);
				await runtime.record(step.tool, validated, observation, {
					predicted: judgement.predicted ?? null,
					surprise: judgement.surprise !== undefined,
					committed: true,
				});
				outcomes.push({
					index,
					tool: step.tool,
					executed: true,
					match: judgement.match,
					predicted: judgement.predicted,
					observed: verdict.observed,
					error: observation.ok ? undefined : observation.text.split("\n", 1)[0],
				});
				if (judgement.surprise === undefined) continue;
				surprises.push(judgement.surprise);
				// Strict mode stops at the first surprise. Guided mode records the counterexample
				// and keeps executing, so a weak model is never stranded halfway through a plan.
				if (!guided) {
					voided = true;
					break;
				}
			}
		});

		for (let index = outcomes.length; index < params.steps.length; index++) {
			outcomes.push({ index, tool: params.steps[index].tool, executed: false });
		}

		if (voided) runtime.voidPlan(surprises[0]);
		else runtime.clearVoidedPlan();

		const recertified = await runtime.certify(signal);
		const executed = outcomes.filter(outcome => outcome.executed).length;
		let summary: string;
		if (voided) {
			summary =
				`Plan voided after ${executed}/${params.steps.length} step(s). ${surprises[0]}.\n` +
				"Reality outranks the model: take this counterexample to `schema_model`, fix the belief it refutes, " +
				"then re-certify and search again.";
		} else if (surprises.length > 0) {
			summary =
				`All ${executed} step(s) executed; ${surprises.length} surprise(s) recorded (guided mode keeps going):\n` +
				`${surprises.map(surprise => `- ${surprise}`).join("\n")}\n` +
				"Fix the beliefs they refute in `schema_model`.";
		} else {
			summary = `All ${executed} step(s) executed with 0 mispredictions.`;
		}
		const noticeBlock = notices.length > 0 ? `${notices.join("\n")}\n\n` : "";
		return {
			content: text(`${summary}\n\n${noticeBlock}${formatBacktest(recertified)}`),
			details: { executed, requested: params.steps.length, voided, steps: outcomes },
			...(voided ? { isError: true } : {}),
		};
	}

	/** Advance the live model, reopening it once if the VM lost it. A model that threw is not replayed again. */
	async #checkStep(
		runtime: SchemaRuntime,
		source: string,
		action: SchemaAction,
		observation: { ok: boolean; text: string; details?: unknown },
		signal?: AbortSignal,
	): Promise<AdvanceResult> {
		const verdict = await advanceLiveModel(this.session, action, observation, signal);
		if (!verdict.stale || verdict.error !== undefined) return verdict;
		await openLiveModel(this.session, source, await runtime.harnessTransitions(), signal);
		return await advanceLiveModel(this.session, action, observation, signal);
	}
}

/** Rank candidate actions by how much uncertainty each resolves. */
export class SchemaExperimentTool implements AgentTool<typeof schemaExperimentSchema, SchemaExperimentDetails> {
	readonly name = "schema_experiment";
	readonly approval = "read" as const;
	readonly label = "Design Experiment";
	readonly description = schemaExperimentDescription;
	readonly parameters = schemaExperimentSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Rank candidate actions by the hypotheses they separate";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SchemaExperimentTool | null {
		return isSchemaEnabled(session) ? new SchemaExperimentTool(session) : null;
	}

	async execute(
		_id: string,
		params: SchemaExperimentParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SchemaExperimentDetails>> {
		const runtime = requireSchemaMode(this.session);
		throwIfAborted(signal);
		if (params.hypotheses.length < 2) {
			throw new ToolError("Give at least two hypotheses: an experiment is only useful when it separates rivals.");
		}
		const hypotheses: Hypothesis[] = params.hypotheses.map(entry => ({
			id: entry.id,
			claim: entry.claim,
			predicts: Object.fromEntries(
				Object.entries(entry.predicts as Record<string, unknown>).map(([action, value]) => [action, String(value)]),
			),
		}));
		await runtime.store.setHypotheses(hypotheses);
		const rankings = rankExperiments(hypotheses, params.candidates);
		if (rankings.length === 0) throw new ToolError("No candidate actions to rank.");
		const lines = rankings.map(ranking => {
			const groups = Object.entries(ranking.outcomes)
				.map(([outcome, ids]) => `${ids.join("+")} ⇒ ${outcome}`)
				.join(" · ");
			const silent = ranking.silent.length > 0 ? ` · silent: ${ranking.silent.join(", ")}` : "";
			return `${ranking.action}: splits ${ranking.splits}, ties ${ranking.ties}${silent}\n  ${groups || "(no predictions)"}`;
		});
		const best = rankings[0];
		const verdict =
			best.splits > 0
				? `Most discriminating: \`${best.action}\` (separates ${best.splits} hypothesis pair(s)). Commit it and compare.`
				: "No candidate separates any pair. Every hypothesis predicts the same outcome, so none of these actions " +
					"can teach you anything — widen the candidates or sharpen the hypotheses.";
		return {
			content: text(`${lines.join("\n")}\n\n${verdict}`),
			details: { best: best.action, rankings: rankings.length },
		};
	}
}
