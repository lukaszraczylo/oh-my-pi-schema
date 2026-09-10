import * as path from "node:path";
import type { ToolSession } from "../tools";

/** Directory name schema-mode state lives under, relative to the project root. */
export const SCHEMA_DIR_NAME = path.join(".omp", "schema");

export const WORLD_MODEL_FILE = "world_model.js";
export const NOTES_FILE = "notes.md";
export const TIMELINE_FILE = "timeline.jsonl";
export const LEDGER_FILE = "ledger.json";

export interface SchemaPaths {
	root: string;
	worldModel: string;
	notes: string;
	timeline: string;
	ledger: string;
}

/**
 * Resolve where the persistent world model, notes, and timeline live.
 *
 * Project-scoped by default rather than session-scoped: a certified model is the
 * expensive artifact, and the paper's efficiency comes from reusing it on later
 * work rather than rediscovering it. `schema.stateDir` overrides the location.
 */
export function resolveSchemaPaths(session: ToolSession): SchemaPaths {
	const configured = session.settings.get("schema.stateDir")?.trim();
	const root = configured ? path.resolve(session.cwd, configured) : path.join(session.cwd, SCHEMA_DIR_NAME);
	return {
		root,
		worldModel: path.join(root, WORLD_MODEL_FILE),
		notes: path.join(root, NOTES_FILE),
		timeline: path.join(root, TIMELINE_FILE),
		ledger: path.join(root, LEDGER_FILE),
	};
}
