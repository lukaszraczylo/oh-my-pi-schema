// world_model.js — your theory of this codebase, as a runnable program.
//
// This file is the agent's memory. It is interpretable (read and diff it),
// verifiable (schema_backtest replays it against every recorded action), and
// searchable (schema_plan runs breadth-first search inside it for free).
//
// It works as-is: it predicts `ok` for every successful edit, write, and ast_edit,
// so a fresh session can commit straight away. Grow it from there — add a case to
// step() the first time a prediction would have saved you a run.
//
// Coverage counts only world-changing actions (edits and writes). Reads, greps, and
// other observation never count against you, so explore freely.
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
		// Example — replace with the quantities this task actually turns on.
		buildGreen: null,
		failingTests: [],
	};
}

/** Tools that change files. A successful call is predictable from the first session. */
function isFileTool(tool) {
	return tool === "edit" || tool === "write" || tool === "ast_edit";
}

/**
 * The mechanism. Given a state and one real action, return the next state and the
 * projection you commit to for that action's observation.
 *
 * action:      { run, index, tool, args }
 * return:      { state, predict }
 *
 * `predict` is compared verbatim against digest(observation, action). Return null to
 * decline — fine for reads; world-changing actions you decline count against coverage
 * once the floor applies.
 */
function step(state, action) {
	if (isFileTool(action.tool)) {
		return { state: state, predict: "ok" };
	}
	switch (action.tool) {
		// Example — predict a test run once you know what it should report:
		// case "bash":
		// 	if (/\btest\b/.test(String(action.args && action.args.command))) {
		// 		return { state: state, predict: "exit=0 pass=12 fail=0" };
		// 	}
		// 	return { state: state, predict: null };
		default:
			return { state: state, predict: null };
	}
}

/**
 * Project a recorded observation onto the space step() predicts in. Keep it to the few
 * facts that decide a step, so two identical outcomes always compare equal. Return null
 * when an observation has nothing to check, such as a failed edit: the entry is skipped,
 * not counted as a mismatch.
 *
 * observation: { ok, text, details }
 * action:      { run, index, tool, args }
 */
function digest(observation, action) {
	const text = String(observation.text || "");
	const firstLine = (text.split("\n").find(line => line.trim() !== "") || "").trim().slice(0, 120);
	if (action && isFileTool(action.tool)) {
		// A failed edit refutes no belief about the codebase, so it is skipped, not a mismatch.
		return observation.ok ? "ok" : null;
	}
	const facts = [];
	const details = observation.details || {};
	if (typeof details.exitCode === "number") facts.push("exit=" + details.exitCode);
	const passed = /(\d+)\s+pass(?:ed|ing|es)?\b/i.exec(text);
	const failed = /(\d+)\s+fail(?:ed|ing|ures?|s)?\b/i.exec(text);
	if (passed) facts.push("pass=" + passed[1]);
	if (failed) facts.push("fail=" + failed[1]);
	if (facts.length > 0) return facts.join(" ");
	return observation.ok ? "ok" : "error: " + firstLine;
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
