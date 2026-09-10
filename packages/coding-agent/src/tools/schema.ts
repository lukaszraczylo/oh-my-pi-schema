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
		throw new ToolError("Schema mode is off for this session. Set `schema.enabled true` to use the schema tools.");
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
		`coverage ${(report.coverage * 100).toFixed(0)}% · state keys [${report.stateKeys.join(", ")}] · ` +
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
			const { source, seeded } = await store.readModel();
			const notes = await store.readNotes();
			const header = seeded ? "world_model.js did not exist; the scaffold below was created.\n\n" : "";
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
		await runtime.requireCertification(signal);
		const { source } = await runtime.store.readModel();
		const transitions = (await runtime.timeline.transitions()).map(entry => ({
			action: entry.action,
			observation: entry.observation,
		}));
		const limits = {
			maxNodes: Math.max(1, Math.trunc(params.maxNodes ?? this.session.settings.get("schema.maxSearchNodes"))),
			maxDepth: Math.max(1, Math.trunc(params.maxDepth ?? this.session.settings.get("schema.maxPlanDepth"))),
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
		return { content: text(body), details: { plan } };
	}
}

/** The only channel from thinking to action. */
export class SchemaCommitTool implements AgentTool<typeof schemaCommitSchema, SchemaCommitDetails> {
	readonly name = "schema_commit";
	readonly approval = "write" as const;
	readonly label = "Commit Actions";
	readonly description = schemaCommitDescription;
	readonly parameters = schemaCommitSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Execute a predicted plan against the world, stopping on the first surprise";

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
		await runtime.requireCertification(signal);

		const { source } = await runtime.store.readModel();
		const history = (await runtime.timeline.transitions()).map(entry => ({
			action: entry.action,
			observation: entry.observation,
		}));
		await openLiveModel(this.session, source, history, signal);

		const outcomes: SchemaCommitStepOutcome[] = [];
		const notices: string[] = [];
		let voided = false;
		let voidReason = "";

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
				const verdict = await this.#checkStep(runtime, source, action, observation, signal);
				// The written model is the authority. A declared projection that disagrees with
				// it means the belief being acted on was never encoded, so the plan stops here.
				const declaredConflict =
					step.predict !== undefined && verdict.predicted !== undefined && step.predict !== verdict.predicted;
				if (step.predict !== undefined && verdict.skipped === true) {
					notices.push(
						`step ${index} (${step.tool}) declared "${step.predict}" but world_model.js declined to predict it — ` +
							"encode that belief in step() so it can be certified.",
					);
				}
				const surprise = verdict.match === false || declaredConflict;
				await runtime.record(step.tool, validated, observation, step.predict ?? null, surprise);
				outcomes.push({
					index,
					tool: step.tool,
					executed: true,
					match: verdict.match,
					predicted: verdict.predicted,
					observed: verdict.observed,
					error: observation.ok ? undefined : observation.text.split("\n", 1)[0],
				});
				if (surprise) {
					voided = true;
					voidReason = declaredConflict
						? `step ${index} (${step.tool}) declared "${step.predict}" while world_model.js predicts "${verdict.predicted}" — your stated expectation and your written theory disagree`
						: `step ${index} (${step.tool}) mispredicted: expected ${verdict.predicted}, observed ${verdict.observed}`;
					break;
				}
			}
		});

		for (let index = outcomes.length; index < params.steps.length; index++) {
			outcomes.push({ index, tool: params.steps[index].tool, executed: false });
		}

		if (voided) runtime.voidPlan(voidReason);
		else runtime.clearVoidedPlan();

		const recertified = await runtime.certify(signal);
		const executed = outcomes.filter(outcome => outcome.executed).length;
		const summary = voided
			? `Plan voided after ${executed}/${params.steps.length} step(s). ${voidReason}.\n` +
				"Reality outranks the model: take this counterexample to `schema_model`, fix the belief it refutes, " +
				"then re-certify and search again."
			: `All ${executed} step(s) executed with 0 mispredictions.`;
		const noticeBlock = notices.length > 0 ? `${notices.join("\n")}\n\n` : "";
		return {
			content: text(`${summary}\n\n${noticeBlock}${formatBacktest(recertified)}`),
			details: { executed, requested: params.steps.length, voided, steps: outcomes },
			...(voided ? { isError: true } : {}),
		};
	}

	/** Advance the live model, falling back to a full replay if the VM lost it. */
	async #checkStep(
		runtime: SchemaRuntime,
		source: string,
		action: SchemaAction,
		observation: { ok: boolean; text: string; details?: unknown },
		signal?: AbortSignal,
	): Promise<AdvanceResult> {
		const verdict = await advanceLiveModel(this.session, action, observation, signal);
		if (!verdict.stale) return verdict;
		const history = (await runtime.timeline.transitions()).map(entry => ({
			action: entry.action,
			observation: entry.observation,
		}));
		await openLiveModel(this.session, source, history, signal);
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
