/**
 * Settings declared by the Schema control loop (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// ────────────────────────────────────────────────────────────────────────
// Schema mode — the executable world-model control loop
// ────────────────────────────────────────────────────────────────────────

export const cfgSchemaEnabled = register({
	id: "schema.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Schema Mode",
		description:
			"Run the observe/deliberate/execute/record loop: keep the world model in world_model.js, certify it against the recorded timeline, and send world-changing actions only through schema_commit",
	},
});

export const cfgSchemaMode = register({
	id: "schema.mode",
	type: "enum",
	values: ["strict", "guided", "off"] as const,
	default: "strict",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Schema Enforcement",
		description:
			"How world-changing tools are handled. Strict runs them only inside schema_commit; guided runs them directly but records and advises; off disables the Schema loop",
		options: [
			{
				value: "strict",
				label: "Strict",
				description: "Edits and writes run only inside schema_commit, checked against the world model",
			},
			{
				value: "guided",
				label: "Guided",
				description: "Edits and writes may run directly; certification problems become warnings",
			},
			{ value: "off", label: "Off", description: "Disable the Schema loop and its tools" },
		],
	},
});

export const cfgSchemaCoverageAfter = register({
	id: "schema.coverageAfter",
	type: "number",
	default: 5,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Coverage Floor Starts After",
		description:
			"World-changing transitions before schema.minCoverage is enforced. Earlier ones only need a backtest without mismatches",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaCoverageScope = register({
	id: "schema.coverageScope",
	type: "enum",
	values: ["session", "project"] as const,
	default: "session",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Coverage Scope",
		description:
			"Which world-changing transitions count toward coverage. Mismatches are always checked across the whole timeline",
		condition: "schemaEnabled",
		options: [
			{ value: "session", label: "This session", description: "Only this session's world-changing transitions" },
			{ value: "project", label: "Whole project", description: "Every session recorded in this project" },
		],
	},
});

export const cfgSchemaGatedTools = register({
	id: "schema.gatedTools",
	type: "array",
	default: ["edit", "write", "ast_edit"],
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Commit-Gated Tools",
		description: "Tools that change the world and therefore run only inside schema_commit",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaGateBash = register({
	id: "schema.gateBash",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Gate Bash Behind Commit",
		description:
			"Also route bash through schema_commit. Off by default because bash is the main observation channel as well as a mutation channel",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaMinCoverage = register({
	id: "schema.minCoverage",
	type: "number",
	default: 0.5,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Minimum Prediction Coverage",
		description:
			"Fraction of recorded transitions the world model must predict before it may plan or commit. A model that predicts nothing certifies nothing",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaMaxSearchNodes = register({
	id: "schema.maxSearchNodes",
	type: "number",
	default: 20000,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Plan Search Node Budget",
		description: "Nodes breadth-first search may expand inside the world model before it gives up",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaMaxPlanDepth = register({
	id: "schema.maxPlanDepth",
	type: "number",
	default: 64,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Plan Depth Limit",
		description: "Longest action sequence schema_plan may return",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaTimeoutMs = register({
	id: "schema.timeoutMs",
	type: "number",
	default: 15000,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "World Model Timeout",
		description: "Milliseconds a single world-model replay or search may run before it is cancelled",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaEpicycleThreshold = register({
	id: "schema.epicycleThreshold",
	type: "number",
	default: 3,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Epicycle Warning Threshold",
		description:
			"Consecutive rule-only revisions with an unchanged state representation and a red backtest before schema_model status advises changing the representation",
		condition: "schemaEnabled",
	},
});

export const cfgSchemaStateDir = register({
	id: "schema.stateDir",
	type: "string",
	default: undefined,
});
