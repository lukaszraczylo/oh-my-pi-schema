/**
 * Schema mode data contracts.
 *
 * The design follows the Schema harness (Impossible Research, 2026,
 * https://schema-harness.github.io/): the agent's beliefs about the world live in an
 * executable program instead of in context, every real interaction is appended to an
 * immutable timeline, the program is certified against that timeline before it is
 * trusted, plans are searched inside the certified program, and reality outranks the
 * program during execution.
 */

/** One real interaction the agent had with the world, as the world model sees it. */
export interface SchemaAction {
	/** Session id that produced the action. Lets the model compare two complete runs. */
	run: string;
	/** Zero-based position in the timeline. */
	index: number;
	/** Tool that was invoked. */
	tool: string;
	/** Validated tool arguments. */
	args: unknown;
}

/** What the world answered. `text` is the tool's rendered output; `details` its structured payload. */
export interface SchemaObservation {
	ok: boolean;
	text: string;
	details?: unknown;
}

/** An append-only timeline record. Timeline entries are never rewritten. */
export interface TimelineEntry {
	seq: number;
	ts: number;
	run: string;
	tool: string;
	args: unknown;
	observation: SchemaObservation;
	/** Projection the model committed to before the action ran, when it came through `schema_commit`. */
	predicted?: string | null;
	/** Set when the live prediction check for this step failed. */
	surprise?: boolean;
	/** Set when the step ran through `schema_commit`. Committed transitions count toward coverage. */
	committed?: boolean;
}

/** A single point where the certified program disagrees with recorded reality. */
export interface BacktestMismatch {
	seq: number;
	tool: string;
	predicted: string;
	observed: string;
}

/** Result of replaying the world model over the entire timeline. */
export interface BacktestReport {
	/** Timeline entries considered. */
	total: number;
	/** Entries the model committed a projection for. */
	checked: number;
	/** Entries the model declined to predict (`predict: null`). */
	skipped: number;
	/** Entries whose projection matched the recording exactly. */
	matched: number;
	mismatches: BacktestMismatch[];
	/** Transitions that count toward coverage: committed or world-changing, within the configured scope. */
	billable: number;
	/** Billable transitions the model predicted. */
	billableChecked: number;
	/** Billable transitions the model declined to predict, counted by tool. */
	uncovered: Record<string, number>;
	/** `billableChecked / billable`, or 1 when nothing is billable. Reads and searches never count. */
	coverage: number;
	/** True when every checked entry matched and the program ran without throwing. */
	green: boolean;
	/** Top-level keys of the state the model ends the replay in — the representation fingerprint. */
	stateKeys: string[];
	/** Whether `is_goal` holds in the replayed final state. */
	goalReached: boolean;
	/** Runtime error raised by the world model, if any. */
	error?: string;
}

/** Result of breadth-first search inside the certified world model. */
export interface PlanReport {
	found: boolean;
	/** Actions from the replayed final state to a goal state. */
	actions: unknown[];
	/** Nodes expanded during the search. */
	expanded: number;
	/** Distinct states visited. */
	distinct: number;
	/** Search stopped because the node budget ran out. */
	exhausted: boolean;
	error?: string;
}

/** Verdict for one live-committed step: did reality match the projection the model made? */
export interface AdvanceResult {
	/** The live model is unavailable: the VM lost it, or the model threw on this step. */
	stale: boolean;
	/** Why the model could not judge this step, when it threw. */
	error?: string;
	/** The model declined to predict this action. */
	skipped?: boolean;
	match?: boolean;
	predicted?: string;
	/** The observation's digest, even when the model declined to predict. Undefined when the digest had nothing to check. */
	observed?: string;
	goalReached?: boolean;
	stateKeys?: string[];
}

/** A competing explanation of the world, with the outcomes it predicts per candidate action. */
export interface Hypothesis {
	id: string;
	claim: string;
	/** Candidate action label to the projection this hypothesis predicts for it. */
	predicts: Record<string, string>;
}

/** How well one candidate action separates the live hypotheses. */
export interface ExperimentRanking {
	action: string;
	/** Hypothesis pairs this action tells apart. */
	splits: number;
	/** Hypothesis pairs that stay indistinguishable after this action. */
	ties: number;
	/** Hypotheses that declined to predict this action. */
	silent: string[];
	/** Distinct predicted outcomes, grouped by outcome. */
	outcomes: Record<string, string[]>;
}

/** One recorded edit of the world model program. */
export interface ModelRevision {
	version: number;
	ts: number;
	bytes: number;
	note: string;
	/** Representation fingerprint after this revision, once a backtest has run. */
	stateKeys?: string[];
	/** Backtest verdict recorded after this revision. */
	green?: boolean;
	mismatches?: number;
}

/** Persisted schema-mode bookkeeping. The timeline lives in its own append-only file. */
export interface SchemaLedger {
	version: 1;
	revisions: ModelRevision[];
	hypotheses: Hypothesis[];
}

/** Verdict of the last certification, used to gate planning and committing. */
export interface CertificationState {
	/** Model bytes the verdict was computed for. A later edit invalidates it. */
	modelHash: string;
	/** Timeline length the verdict was computed for. A later action invalidates it. */
	timelineLength: number;
	/** Settings that decided which transitions were billable. A change invalidates the verdict. */
	billingKey: string;
	report: BacktestReport;
}
