import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { resolveSchemaPaths } from "./paths";
import { backtestWorldModel } from "./runner";
import { modelHash, SchemaStore } from "./store";
import { Timeline } from "./timeline";
import type { BacktestReport, CertificationState, SchemaObservation } from "./types";

/** Tools that change the world and therefore may only run inside a commit. */
export const DEFAULT_GATED_TOOLS = ["edit", "write", "ast_edit"] as const;

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

const runtimes = new WeakMap<ToolSession, SchemaRuntime>();

/** True when this session runs the Schema control loop rather than the free-form loop. */
export function isSchemaEnabled(session: ToolSession): boolean {
	return session.settings.get("schema.enabled") === true;
}

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
	 * Reality outranks the model: nothing reaches the world except through a committed,
	 * predicted plan searched inside a certified program.
	 */
	assertCommitChannel(toolName: string): void {
		if (this.committing) return;
		throw new ToolError(
			`Schema mode: \`${toolName}\` changes the world, so it only runs inside \`schema_commit\`. ` +
				"Update `world_model.js` with `schema_model`, certify it with `schema_backtest`, search it with " +
				"`schema_plan`, then commit the plan — each step carrying the projection you expect. " +
				"Set `schema.enabled false` to leave the Schema loop.",
		);
	}

	/** Append one real transition to the immutable record. */
	async record(
		tool: string,
		args: unknown,
		observation: SchemaObservation,
		predicted?: string | null,
		surprise?: boolean,
	): Promise<void> {
		await this.#timeline.append({ run: this.runId, tool, args, observation, predicted, surprise });
		// A new transition means the certified model has not been checked against
		// everything that happened. It must be re-certified before it is trusted again.
		this.#certification = undefined;
	}

	/** The certification verdict, or undefined when it is missing or stale. */
	async certification(): Promise<CertificationState | undefined> {
		const current = this.#certification;
		if (!current) return undefined;
		const { source } = await this.#store.readModel();
		if (modelHash(source) !== current.modelHash) return undefined;
		if ((await this.#timeline.length()) !== current.timelineLength) return undefined;
		return current;
	}

	/** Replay the world model over the complete timeline and cache the verdict. */
	async certify(signal?: AbortSignal): Promise<BacktestReport> {
		const { source } = await this.#store.readModel();
		const transitions = (await this.#timeline.transitions()).map(entry => ({
			action: entry.action,
			observation: entry.observation,
		}));
		const { report } = await backtestWorldModel(this.#session, source, transitions, signal);
		this.#certification = { modelHash: modelHash(source), timelineLength: transitions.length, report };
		await this.#store.recordVerdict({
			stateKeys: report.stateKeys,
			green: report.green,
			mismatches: report.mismatches.length,
		});
		return report;
	}

	/**
	 * A certified model, or a pointed refusal. Planning and committing both need one:
	 * search is only complete relative to the model it runs over, so an uncertified
	 * model turns exhaustive search into a confident wrong answer.
	 */
	async requireCertification(signal?: AbortSignal): Promise<BacktestReport> {
		const cached = await this.certification();
		const report = cached?.report ?? (await this.certify(signal));
		if (!report.green) {
			throw new ToolError(
				`Schema mode: the world model does not reproduce recorded reality ` +
					`(${report.matched}/${report.checked} exact, ${report.mismatches.length} mismatch(es)` +
					`${report.error ? `, error: ${report.error}` : ""}). ` +
					"Fix `world_model.js` and re-run `schema_backtest` before planning or committing.",
			);
		}
		const minimum = this.#session.settings.get("schema.minCoverage");
		if (report.total > 0 && report.coverage < minimum) {
			throw new ToolError(
				`Schema mode: the model predicts only ${(report.coverage * 100).toFixed(0)}% of the ` +
					`${report.total} recorded transitions (minimum ${(minimum * 100).toFixed(0)}%). ` +
					"A model that predicts nothing certifies nothing — commit projections for the actions that matter.",
			);
		}
		return report;
	}
}
