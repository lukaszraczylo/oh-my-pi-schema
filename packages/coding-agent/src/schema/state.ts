import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { resolveSchemaPaths } from "./paths";
import { backtestWorldModel, type HarnessTransition } from "./runner";
import { modelHash, SchemaStore } from "./store";
import { Timeline } from "./timeline";
import type { BacktestReport, CertificationState, SchemaObservation } from "./types";

/** Tools that change the world and therefore may only run inside a commit. */
export const DEFAULT_GATED_TOOLS = ["edit", "write", "ast_edit"] as const;

/**
 * How the Schema loop treats world-changing tools. `strict` runs them only inside
 * `schema_commit`; `guided` lets them run directly and advises; `off` disables the loop.
 */
export type SchemaMode = "strict" | "guided" | "off";

/** What is recorded alongside a transition. */
export interface RecordOptions {
	/** The prediction checked against this transition, if any. */
	predicted?: string | null;
	/** The check failed, or the step failed without a matched prediction. */
	surprise?: boolean;
	/** The transition ran through `schema_commit`. */
	committed?: boolean;
}

/** A certification verdict, with the problems guided mode reports instead of refusing. */
export interface CertificationOutcome {
	report: BacktestReport;
	warnings: string[];
}

/**
 * The tools this session holds behind the commit channel. Resolved from settings so
 * `createTools` can ask the same question before a runtime exists.
 */
export function gatedToolNames(session: ToolSession): Set<string> {
	const configured = session.settings.get("schema.gatedTools");
	const names = new Set<string>(configured.length > 0 ? configured : DEFAULT_GATED_TOOLS);
	if (session.settings.get("schema.gateBash")) names.add("bash");
	return names;
}

/**
 * The active Schema mode. `schema.enabled false` wins over `schema.mode`, so the original
 * on/off switch keeps working.
 */
export function schemaMode(session: ToolSession): SchemaMode {
	if (session.settings.get("schema.enabled") !== true) return "off";
	return session.settings.get("schema.mode");
}

/** True when this session runs the Schema control loop rather than the free-form loop. */
export function isSchemaEnabled(session: ToolSession): boolean {
	return schemaMode(session) !== "off";
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** Name the first disagreement and the call that fixes it, not only the count. */
function describeMismatch(report: BacktestReport): string {
	const first = report.mismatches[0];
	const where = first
		? ` First disagreement: timeline entry ${first.seq} (${first.tool}) — predicted \`${first.predicted}\`, observed \`${first.observed}\`.`
		: "";
	const error = report.error ? ` world_model.js raised: ${report.error}.` : "";
	return (
		"Schema mode: the world model does not reproduce recorded reality " +
		`(${report.matched}/${report.checked} exact, ${report.mismatches.length} mismatch(es)).${where}${error} ` +
		"Next: `schema_model action:read`, fix `step()` or `digest()` for that tool, then `schema_backtest`."
	);
}

/** Say which world-changing actions lack predictions and exactly what closes the gap. */
function describeCoverageGap(report: BacktestReport, minimum: number, after: number): string {
	const unpredicted = Object.entries(report.uncovered)
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([tool, count]) => `${tool} ×${count}`)
		.join(", ");
	return (
		`Schema mode: world_model.js predicts ${report.billableChecked} of ${report.billable} world-changing transitions ` +
		`(${percent(report.coverage)}, minimum ${percent(minimum)}). Unpredicted: ${unpredicted || "none"}. ` +
		"Next: add a case for those tools to `step()` that returns the `predict` your `digest()` produces for the real " +
		'observation — for example `"ok"` for a successful edit, or `"exit=0 pass=12 fail=0"` for a test run — then run ' +
		`\`schema_backtest\`. Reads never count; the floor applies from ${after} world-changing transitions (\`schema.coverageAfter\`).`
	);
}

const runtimes = new WeakMap<ToolSession, SchemaRuntime>();

/**
 * Per-session Schema state: the timeline, the persistent model store, the current
 * certification verdict, and the commit gate.
 *
 * Held in a WeakMap keyed by the ToolSession so every tool in a session shares one
 * runtime without threading state through the session constructor.
 */
export class SchemaRuntime {
	#session: ToolSession;
	#timeline: Timeline;
	#store: SchemaStore;
	#certification: CertificationState | undefined;
	#commitDepth = 0;
	#voidedPlan: string | undefined;

	constructor(session: ToolSession) {
		const paths = resolveSchemaPaths(session);
		this.#session = session;
		this.#timeline = Timeline.for(paths.timeline);
		this.#store = new SchemaStore(paths);
	}

	static for(session: ToolSession): SchemaRuntime {
		const existing = runtimes.get(session);
		if (existing) return existing;
		const created = new SchemaRuntime(session);
		runtimes.set(session, created);
		return created;
	}

	get timeline(): Timeline {
		return this.#timeline;
	}

	get store(): SchemaStore {
		return this.#store;
	}

	get mode(): SchemaMode {
		return schemaMode(this.#session);
	}

	/** Identifier stamped on every timeline entry so two complete runs stay comparable. */
	get runId(): string {
		return this.#session.getSessionId?.() ?? "local";
	}

	/** The prediction failure that voided the last committed plan, if it has not been cleared. */
	get voidedPlan(): string | undefined {
		return this.#voidedPlan;
	}

	voidPlan(reason: string): void {
		this.#voidedPlan = reason;
	}

	clearVoidedPlan(): void {
		this.#voidedPlan = undefined;
	}

	/** True while `schema_commit` is executing the queue. The gate is open only here. */
	get committing(): boolean {
		return this.#commitDepth > 0;
	}

	async withCommitChannel<T>(run: () => Promise<T>): Promise<T> {
		this.#commitDepth++;
		try {
			return await run();
		} finally {
			this.#commitDepth--;
		}
	}

	/** Names of the tools that may only run inside a commit. */
	gatedTools(): Set<string> {
		return gatedToolNames(this.#session);
	}

	/**
	 * Gate a world-changing tool called outside `schema_commit`. Strict mode refuses the
	 * call and names the call that works instead. Guided mode lets it run and returns the
	 * advice to attach to its result. Returns undefined when no gate applies.
	 */
	commitChannelNotice(toolName: string): string | undefined {
		if (this.committing || !this.gatedTools().has(toolName)) return undefined;
		if (this.mode === "strict") {
			throw new ToolError(
				`Schema mode (strict): \`${toolName}\` changes the world, so it only runs inside \`schema_commit\`. ` +
					`Next call: \`schema_commit\` with \`steps: [{ tool: "${toolName}", args: { … } }]\`. ` +
					"The seed world model already predicts `ok` for successful edits and writes, so a fresh session can commit " +
					"straight away; `schema_model action:status` shows anything that blocks certification. " +
					"To call world-changing tools directly, set `schema.mode` to `guided`.",
			);
		}
		return (
			`\`${toolName}\` ran outside \`schema_commit\` (guided mode): it is recorded, but its outcome was not checked ` +
			"against the world model when it ran. Route the next change through `schema_commit` so it is."
		);
	}

	/** Append one real transition to the immutable record. */
	async record(
		tool: string,
		args: unknown,
		observation: SchemaObservation,
		options: RecordOptions = {},
	): Promise<void> {
		await this.#timeline.append({ run: this.runId, tool, args, observation, ...options });
		// A new transition means the certified model has not been checked against
		// everything that happened. It must be re-certified before it is trusted again.
		this.#certification = undefined;
	}

	/**
	 * The recorded history in replay form, each transition flagged when it counts toward
	 * coverage. Only transitions made with a gated, world-changing tool count, whether they
	 * ran inside a commit or directly in guided mode: reading the world is free, as it is in
	 * the paper, so exploring, and even committing a read or a test run, can never make
	 * certification harder. Session scope also keeps earlier sessions' transitions off the
	 * bill; they are still replayed and still fail certification on a mismatch.
	 */
	async harnessTransitions(): Promise<HarnessTransition[]> {
		const gated = this.gatedTools();
		const sessionScoped = this.#session.settings.get("schema.coverageScope") === "session";
		const runId = this.runId;
		return (await this.#timeline.transitions()).map(({ action, observation, recorded }) => ({
			action,
			observation,
			billable: gated.has(recorded.tool) && (!sessionScoped || recorded.run === runId),
		}));
	}

	/** The settings a certification verdict depends on beyond the model and the timeline. */
	#billingKey(): string {
		const scope = this.#session.settings.get("schema.coverageScope");
		return [scope, this.runId, ...[...this.gatedTools()].sort()].join("|");
	}

	/** The certification verdict, or undefined when it is missing or stale. */
	async certification(): Promise<CertificationState | undefined> {
		const current = this.#certification;
		if (!current) return undefined;
		const { source } = await this.#store.readModel();
		if (modelHash(source) !== current.modelHash) return undefined;
		if ((await this.#timeline.length()) !== current.timelineLength) return undefined;
		if (this.#billingKey() !== current.billingKey) return undefined;
		return current;
	}

	/** Replay the world model over the complete timeline and cache the verdict. */
	async certify(signal?: AbortSignal): Promise<BacktestReport> {
		const { source } = await this.#store.readModel();
		const transitions = await this.harnessTransitions();
		const { report } = await backtestWorldModel(this.#session, source, transitions, signal);
		this.#certification = {
			modelHash: modelHash(source),
			timelineLength: transitions.length,
			billingKey: this.#billingKey(),
			report,
		};
		await this.#store.recordVerdict({
			stateKeys: report.stateKeys,
			green: report.green,
			mismatches: report.mismatches.length,
		});
		return report;
	}

	/**
	 * Certify before planning or committing. Search is only complete relative to the
	 * model it runs over, so an uncertified model turns exhaustive search into a confident
	 * wrong answer.
	 *
	 * The coverage floor waits for `schema.coverageAfter` world-changing transitions: the
	 * paper's agent acts while its model is still provisional, and a floor on the first
	 * commit strands a fresh session. A mismatch always counts. Strict mode refuses; guided
	 * mode returns the same problems as warnings.
	 */
	async requireCertification(signal?: AbortSignal): Promise<CertificationOutcome> {
		const cached = await this.certification();
		const report = cached?.report ?? (await this.certify(signal));
		const problems: string[] = [];
		if (!report.green) problems.push(describeMismatch(report));
		const minimum = this.#session.settings.get("schema.minCoverage");
		const after = this.#session.settings.get("schema.coverageAfter");
		if (report.billable >= after && report.coverage < minimum) {
			problems.push(describeCoverageGap(report, minimum, after));
		}
		if (problems.length === 0) return { report, warnings: [] };
		if (this.mode === "strict") throw new ToolError(problems.join("\n\n"));
		return { report, warnings: problems.map(problem => `${problem} (guided mode: continuing anyway)`) };
	}
}
