// world_model.js — your theory of this codebase, as a runnable program.
//
// This file is the agent's memory. It is interpretable (read and diff it),
// verifiable (schema_backtest replays it against every recorded action), and
// searchable (schema_plan runs breadth-first search inside it for free).
//
// Two layers live here together, and either may be wrong:
//   1. STATE GROUNDING — what the world is. Which files, services, invariants,
//      and quantities matter. Nothing tells you which of them count.
//   2. MECHANISM — how actions change that state, encoded in step().
// When a prediction keeps failing, suspect the representation before you patch
// the rule. Adding a special case to keep a wrong representation alive is an
// epicycle; schema_model status counts them.
//
// Declare plain top-level functions. Everything except step() is optional.

/** The world before any recorded action. Return the smallest state that explains the work. */
function initialState() {
	return {
		// Example — replace with the entities this task actually turns on.
		files: {},
		buildGreen: null,
		failingTests: [],
	};
}

/**
 * The mechanism. Given a state and one real action, return the next state and the
 * projection you commit to for that action's observation.
 *
 * action:      { run, index, tool, args }
 * return:      { state, predict }
 *
 * `predict` is a string compared verbatim against digest(observation). Return null
 * to decline a prediction — honest, but it certifies nothing, and coverage falls.
 */
function step(state, action) {
	switch (action.tool) {
		default:
			return { state: state, predict: null };
	}
}

/**
 * Project a recorded observation onto the same space step() predicts in.
 *
 * observation: { ok, text, details }
 * Return null to skip the entry. The default (no digest) compares trimmed raw text,
 * which almost never matches — narrow it to the line that carries the meaning.
 */
function digest(observation) {
	return observation.text.trim();
}

/** Does this state satisfy the task? schema_plan searches for a state where it holds. */
function isGoal(state) {
	return state.buildGreen === true && state.failingTests.length === 0;
}

/** Actions the planner may try from this state. Keep the branching factor small. */
function actions(state) {
	return [];
}

/** Dedup key for search. Two states with the same key are the same node. */
function key(state) {
	return JSON.stringify(state);
}
