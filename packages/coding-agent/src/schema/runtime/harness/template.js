// Schema world-model harness.
//
// Appended after the agent's world_model.js inside the JS eval VM. It never mutates
// the world: it replays the recorded timeline through the model (certification) and
// searches inside the model (planning). Both operations are free — they spend no real
// actions.
//
// Results leave through a single sentinel line so the caller can recover them from
// captured stdout without parsing prose.

(function schemaHarness() {
	"use strict";

	const SENTINEL = "__SCHEMA_RESULT__";
	const request = globalThis.__SCHEMA_REQUEST__ || {};

	// The model may declare plain top-level functions or assign onto globalThis.
	// `typeof` on an undeclared identifier is safe, so both shapes resolve here.
	const model = {
		initialState:
			typeof initialState === "function"
				? initialState
				: typeof globalThis.initialState === "function"
					? globalThis.initialState
					: undefined,
		step:
			typeof step === "function" ? step : typeof globalThis.step === "function" ? globalThis.step : undefined,
		digest:
			typeof digest === "function"
				? digest
				: typeof globalThis.digest === "function"
					? globalThis.digest
					: undefined,
		isGoal:
			typeof isGoal === "function"
				? isGoal
				: typeof globalThis.isGoal === "function"
					? globalThis.isGoal
					: undefined,
		actions:
			typeof actions === "function"
				? actions
				: typeof globalThis.actions === "function"
					? globalThis.actions
					: undefined,
		key: typeof key === "function" ? key : typeof globalThis.key === "function" ? globalThis.key : undefined,
	};

	function emit(payload) {
		console.log(SENTINEL + JSON.stringify(payload));
	}

	function describe(error) {
		if (error instanceof Error) return error.stack || error.message;
		return String(error);
	}

	function stateKeysOf(state) {
		if (state === null || typeof state !== "object" || Array.isArray(state)) return [];
		return Object.keys(state).sort();
	}

	function stateKey(state) {
		if (model.key) return String(model.key(state));
		try {
			return JSON.stringify(state);
		} catch {
			return String(state);
		}
	}

	function observationDigest(observation) {
		if (model.digest) {
			const value = model.digest(observation);
			return value === null || value === undefined ? null : String(value);
		}
		return String(observation && observation.text !== undefined ? observation.text : "").trim();
	}

	function replay(transitions) {
		const report = {
			total: transitions.length,
			checked: 0,
			skipped: 0,
			matched: 0,
			mismatches: [],
			coverage: 0,
			green: false,
			stateKeys: [],
			goalReached: false,
		};
		if (!model.step) {
			report.error = "world_model.js declares no step(state, action) function.";
			return { report: report, state: undefined };
		}
		let state;
		try {
			state = model.initialState ? model.initialState() : {};
		} catch (error) {
			report.error = "initialState() threw: " + describe(error);
			return { report: report, state: undefined };
		}
		for (let i = 0; i < transitions.length; i++) {
			const transition = transitions[i];
			let outcome;
			try {
				outcome = model.step(state, transition.action);
			} catch (error) {
				report.error = "step() threw on timeline entry " + transition.action.index + ": " + describe(error);
				report.stateKeys = stateKeysOf(state);
				return { report: report, state: state };
			}
			if (outcome && typeof outcome === "object" && "state" in outcome) state = outcome.state;
			const predicted = outcome && typeof outcome === "object" ? outcome.predict : undefined;
			if (predicted === null || predicted === undefined) {
				report.skipped++;
				continue;
			}
			report.checked++;
			let observed;
			try {
				observed = observationDigest(transition.observation);
			} catch (error) {
				report.error = "digest() threw on timeline entry " + transition.action.index + ": " + describe(error);
				report.stateKeys = stateKeysOf(state);
				return { report: report, state: state };
			}
			if (observed !== null && String(predicted) === String(observed)) {
				report.matched++;
				continue;
			}
			if (report.mismatches.length < 3) {
				report.mismatches.push({
					seq: transition.action.index,
					tool: transition.action.tool,
					predicted: String(predicted).slice(0, 600),
					observed: observed === null ? "(digest returned null)" : String(observed).slice(0, 600),
				});
			}
		}
		report.coverage = report.total === 0 ? 0 : report.checked / report.total;
		report.green = !report.error && report.checked === report.matched;
		report.stateKeys = stateKeysOf(state);
		try {
			report.goalReached = model.isGoal ? Boolean(model.isGoal(state)) : false;
		} catch (error) {
			report.error = "is_goal() threw: " + describe(error);
			report.green = false;
		}
		return { report: report, state: state };
	}

	function search(state, limits) {
		const result = { found: false, actions: [], expanded: 0, distinct: 0, exhausted: false };
		if (!model.step || !model.isGoal || !model.actions) {
			result.error = "Planning needs step(), isGoal(), and actions() in world_model.js.";
			return result;
		}
		const maxNodes = limits.maxNodes;
		const maxDepth = limits.maxDepth;
		const seen = new Set([stateKey(state)]);
		let frontier = [{ state: state, path: [] }];
		try {
			if (model.isGoal(state)) {
				result.found = true;
				result.distinct = seen.size;
				return result;
			}
			while (frontier.length > 0) {
				const next = [];
				for (let i = 0; i < frontier.length; i++) {
					const node = frontier[i];
					if (result.expanded >= maxNodes) {
						result.exhausted = true;
						result.distinct = seen.size;
						return result;
					}
					result.expanded++;
					const candidates = model.actions(node.state) || [];
					for (let c = 0; c < candidates.length; c++) {
						const candidate = candidates[c];
						const outcome = model.step(node.state, candidate);
						const child = outcome && typeof outcome === "object" && "state" in outcome ? outcome.state : node.state;
						const childKey = stateKey(child);
						if (seen.has(childKey)) continue;
						seen.add(childKey);
						const path = node.path.concat([candidate]);
						if (model.isGoal(child)) {
							result.found = true;
							result.actions = path;
							result.distinct = seen.size;
							return result;
						}
						if (path.length < maxDepth) next.push({ state: child, path: path });
					}
				}
				frontier = next;
			}
		} catch (error) {
			result.error = "Search aborted: " + describe(error);
		}
		result.distinct = seen.size;
		return result;
	}

	function advance(request) {
		const live = globalThis.__SCHEMA_LIVE__;
		if (!live || !model.step) {
			return { stale: true };
		}
		const outcome = model.step(live.state, request.action);
		if (outcome && typeof outcome === "object" && "state" in outcome) live.state = outcome.state;
		const predicted = outcome && typeof outcome === "object" ? outcome.predict : undefined;
		const observed = observationDigest(request.observation);
		const goalReached = model.isGoal ? Boolean(model.isGoal(live.state)) : false;
		if (predicted === null || predicted === undefined) {
			return { stale: false, skipped: true, match: true, goalReached: goalReached, stateKeys: stateKeysOf(live.state) };
		}
		return {
			stale: false,
			skipped: false,
			match: observed !== null && String(predicted) === String(observed),
			predicted: String(predicted).slice(0, 600),
			observed: observed === null ? "(digest returned null)" : String(observed).slice(0, 600),
			goalReached: goalReached,
			stateKeys: stateKeysOf(live.state),
		};
	}

	try {
		if (request.op === "advance") {
			emit({ op: "advance", advance: advance(request) });
			return;
		}
		const transitions = Array.isArray(request.transitions) ? request.transitions : [];
		const replayed = replay(transitions);
		if (request.op === "plan") {
			if (!replayed.report.green) {
				emit({
					op: "plan",
					backtest: replayed.report,
					plan: {
						found: false,
						actions: [],
						expanded: 0,
						distinct: 0,
						exhausted: false,
						error: "Refusing to search an uncertified model. Fix the backtest first.",
					},
				});
				return;
			}
			const plan = search(replayed.state, {
				maxNodes: typeof request.maxNodes === "number" ? request.maxNodes : 20000,
				maxDepth: typeof request.maxDepth === "number" ? request.maxDepth : 64,
			});
			emit({ op: "plan", backtest: replayed.report, plan: plan });
			return;
		}
		if (request.op === "open") {
			globalThis.__SCHEMA_LIVE__ = replayed.report.green ? { state: replayed.state } : undefined;
			emit({ op: "open", backtest: replayed.report });
			return;
		}
		emit({ op: "backtest", backtest: replayed.report });
	} catch (error) {
		emit({ op: request.op || "backtest", fatal: describe(error) });
	}
})();
