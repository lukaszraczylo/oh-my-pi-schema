import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { rankExperiments } from "@oh-my-pi/pi-coding-agent/schema/experiment";
import { wrapToolWithSchemaLoop } from "@oh-my-pi/pi-coding-agent/schema/gate";
import { resolveSchemaPaths } from "@oh-my-pi/pi-coding-agent/schema/paths";
import { SchemaRuntime } from "@oh-my-pi/pi-coding-agent/schema/state";
import { countEpicycles } from "@oh-my-pi/pi-coding-agent/schema/store";
import { clampObservation, MAX_OBSERVATION_BYTES, Timeline } from "@oh-my-pi/pi-coding-agent/schema/timeline";
import type { Hypothesis, ModelRevision } from "@oh-my-pi/pi-coding-agent/schema/types";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { judgeStep } from "@oh-my-pi/pi-coding-agent/tools/schema";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let workspace: string;

function makeSession(settingsOverrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "run-1",
		settings: Settings.isolated({ "schema.enabled": true, ...settingsOverrides }),
	};
}

/** Minimal stand-in for a world-changing tool: the wrapper only needs a name and an execute. */
function stubTool(name: string, body: () => AgentToolResult): AgentTool<any, any, any> {
	return {
		name,
		execute: async () => body(),
	} as unknown as AgentTool<any, any, any>;
}

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omps-schema-"));
});

afterEach(async () => {
	await removeWithRetries(workspace);
});

describe("schema commit gate", () => {
	it("rejects a world-changing tool called outside a commit", async () => {
		const session = makeSession();
		const tool = wrapToolWithSchemaLoop(
			session,
			stubTool("edit", () => ({ content: [{ type: "text", text: "ok" }] })),
		);
		await expect(tool.execute("call-1", {}, undefined, undefined, undefined)).rejects.toThrow(/schema_commit/);
	});

	it("runs the same tool inside a commit and records the transition", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		const tool = wrapToolWithSchemaLoop(
			session,
			stubTool("edit", () => ({ content: [{ type: "text", text: "patched" }] })),
		);
		await runtime.withCommitChannel(async () => {
			const result = await tool.execute("call-1", { path: "a.ts" }, undefined, undefined, undefined);
			expect(result.content[0]).toEqual({ type: "text", text: "patched" });
		});
		// The commit queue owns recording inside the channel, so the wrapper must not
		// double-count the transition.
		expect(await runtime.timeline.length()).toBe(0);
	});

	it("records observation tools without gating them", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		const tool = wrapToolWithSchemaLoop(
			session,
			stubTool("grep", () => ({ content: [{ type: "text", text: "3 matches" }] })),
		);
		await tool.execute("call-1", { pattern: "x" }, undefined, undefined, undefined);
		const entries = await runtime.timeline.entries();
		expect(entries).toHaveLength(1);
		expect(entries[0].tool).toBe("grep");
		expect(entries[0].observation.text).toBe("3 matches");
	});

	it("records a thrown tool failure as a failed observation and rethrows", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		const tool = wrapToolWithSchemaLoop(
			session,
			stubTool("grep", () => {
				throw new Error("ripgrep exploded");
			}),
		);
		await expect(tool.execute("call-1", {}, undefined, undefined, undefined)).rejects.toThrow("ripgrep exploded");
		const entries = await runtime.timeline.entries();
		expect(entries).toHaveLength(1);
		expect(entries[0].observation.ok).toBe(false);
		expect(entries[0].observation.text).toBe("ripgrep exploded");
	});

	it("leaves tools ungated when schema mode is off", async () => {
		const session = makeSession({ "schema.enabled": false });
		const tool = wrapToolWithSchemaLoop(
			session,
			stubTool("edit", () => ({ content: [{ type: "text", text: "ok" }] })),
		);
		const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});
});

describe("schema tool roster", () => {
	it("offers the schema tools when the loop is on", async () => {
		const names = (await createTools(makeSession())).map(tool => tool.name);
		expect(names).toContain("schema_model");
		expect(names).toContain("schema_backtest");
		expect(names).toContain("schema_plan");
		expect(names).toContain("schema_commit");
		expect(names).toContain("schema_experiment");
	});

	it("offers none of them when the loop is off", async () => {
		const names = (await createTools(makeSession({ "schema.enabled": false }))).map(tool => tool.name);
		expect(names.filter(name => name.startsWith("schema_"))).toEqual([]);
	});
});

describe("timeline", () => {
	it("survives a reload with sequence numbers intact", async () => {
		const paths = resolveSchemaPaths(makeSession());
		const writer = new Timeline(paths.timeline);
		await writer.append({ run: "run-1", tool: "bash", args: { cmd: "ls" }, observation: { ok: true, text: "a" } });
		await writer.append({ run: "run-1", tool: "read", args: { path: "b" }, observation: { ok: true, text: "b" } });

		const reader = new Timeline(paths.timeline);
		const entries = await reader.entries();
		expect(entries.map(entry => entry.seq)).toEqual([0, 1]);
		expect(entries.map(entry => entry.tool)).toEqual(["bash", "read"]);
	});

	it("marks a clamped observation so a projection cannot match it by accident", () => {
		const clamped = clampObservation("x".repeat(MAX_OBSERVATION_BYTES + 10));
		expect(clamped).toContain("[truncated 10 chars]");
		expect(clamped.length).toBeGreaterThan(MAX_OBSERVATION_BYTES);
	});

	it("projects entries into the action shape the world model replays", async () => {
		const paths = resolveSchemaPaths(makeSession());
		const timeline = new Timeline(paths.timeline);
		await timeline.append({ run: "run-1", tool: "bash", args: { cmd: "ls" }, observation: { ok: true, text: "a" } });
		const [transition] = await timeline.transitions();
		expect(transition.action).toEqual({ run: "run-1", index: 0, tool: "bash", args: { cmd: "ls" } });
	});
});

describe("experiment ranking", () => {
	const hypotheses: Hypothesis[] = [
		{ id: "h1", claim: "cache is keyed by path", predicts: { probe: "hit", touch: "same" } },
		{ id: "h2", claim: "cache is keyed by mtime", predicts: { probe: "miss", touch: "same" } },
	];

	it("ranks the action the hypotheses disagree about above the one they agree on", () => {
		const [first, second] = rankExperiments(hypotheses);
		expect(first.action).toBe("probe");
		expect(first.splits).toBe(1);
		expect(second.action).toBe("touch");
		expect(second.splits).toBe(0);
	});

	it("reports a hypothesis that declines to predict a candidate as silent", () => {
		const partial: Hypothesis[] = [hypotheses[0], { id: "h3", claim: "no opinion", predicts: {} }];
		const [ranking] = rankExperiments(partial, ["probe"]);
		expect(ranking.silent).toEqual(["h3"]);
		expect(ranking.splits).toBe(0);
	});
});

describe("epicycle detection", () => {
	function revision(overrides: Partial<ModelRevision>): ModelRevision {
		return { version: 1, ts: 0, bytes: 10, note: "n", ...overrides };
	}

	it("counts consecutive red revisions that kept the same representation", () => {
		const revisions = [
			revision({ green: false, stateKeys: ["files"] }),
			revision({ green: false, stateKeys: ["files"] }),
			revision({ green: false, stateKeys: ["files"] }),
		];
		expect(countEpicycles(revisions)).toBe(3);
	});

	it("resets the streak when the representation changes", () => {
		const revisions = [
			revision({ green: false, stateKeys: ["files"] }),
			revision({ green: false, stateKeys: ["files", "carry"] }),
		];
		expect(countEpicycles(revisions)).toBe(1);
	});

	it("resets the streak once a revision certifies green", () => {
		const revisions = [
			revision({ green: false, stateKeys: ["files"] }),
			revision({ green: true, stateKeys: ["files"] }),
		];
		expect(countEpicycles(revisions)).toBe(0);
	});
});

describe("schema modes", () => {
	it("tells a strict-mode caller which call works instead", async () => {
		const session = makeSession();
		const tool = wrapToolWithSchemaLoop(
			session,
			stubTool("write", () => ({ content: [{ type: "text", text: "ok" }] })),
		);
		await expect(tool.execute("call-1", {}, undefined, undefined, undefined)).rejects.toThrow(
			/Next call: `schema_commit`/,
		);
	});

	it("lets guided mode run a world-changing tool directly, recorded and advised", async () => {
		const session = makeSession({ "schema.mode": "guided" });
		const runtime = SchemaRuntime.for(session);
		const tool = wrapToolWithSchemaLoop(
			session,
			stubTool("edit", () => ({ content: [{ type: "text", text: "patched" }] })),
		);
		const result = await tool.execute("call-1", { path: "a.ts" }, undefined, undefined, undefined);
		const texts = result.content.map(content => (content as { text: string }).text);
		expect(texts[0]).toBe("patched");
		expect(texts.at(-1)).toContain("[schema]");
		expect((await runtime.timeline.entries()).map(entry => entry.tool)).toEqual(["edit"]);
	});

	it("removes the schema tools when schema.mode is off", async () => {
		const names = (await createTools(makeSession({ "schema.mode": "off" }))).map(tool => tool.name);
		expect(names.filter(name => name.startsWith("schema_"))).toEqual([]);
	});
});

describe("commit step judgement", () => {
	const succeeded = { ok: true, text: "done" };

	it("checks the world model's prediction and turns a differing declaration into advice", () => {
		const judgement = judgeStep(
			0,
			{ tool: "write", predict: "done" },
			{ stale: false, skipped: false, match: true, predicted: "ok", observed: "ok" },
			succeeded,
		);
		expect(judgement.surprise).toBeUndefined();
		expect(judgement.predicted).toBe("ok");
		expect(judgement.notices.join("\n")).toContain('world_model.js predicts "ok"');
	});

	it("checks an inline prediction when the world model declines", () => {
		const matched = judgeStep(
			0,
			{ tool: "bash", predict: "exit=0" },
			{ stale: false, skipped: true, observed: "exit=0" },
			succeeded,
		);
		expect(matched.surprise).toBeUndefined();
		expect(matched.match).toBe(true);

		const missed = judgeStep(
			1,
			{ tool: "bash", predict: "exit=0" },
			{ stale: false, skipped: true, observed: "exit=1" },
			succeeded,
		);
		expect(missed.surprise).toContain('your inline prediction was "exit=0", observed "exit=1"');
	});

	it("flags a surprise when reality disagrees with the world model", () => {
		const judgement = judgeStep(
			2,
			{ tool: "write" },
			{ stale: false, skipped: false, match: false, predicted: "ok", observed: "error" },
			succeeded,
		);
		expect(judgement.surprise).toContain('world_model.js expected "ok", observed "error"');
	});

	it("treats a failed step without a matched prediction as a surprise", () => {
		const judgement = judgeStep(
			0,
			{ tool: "write" },
			{ stale: false, skipped: true },
			{ ok: false, text: "\nEISDIR: illegal operation on a directory\n    at open" },
		);
		expect(judgement.surprise).toBe("step 0 (write) failed: EISDIR: illegal operation on a directory");
	});

	it("accepts a failure the world model predicted", () => {
		const judgement = judgeStep(
			0,
			{ tool: "bash" },
			{ stale: false, skipped: false, match: true, predicted: "exit=1", observed: "exit=1" },
			{ ok: false, text: "1 fail" },
		);
		expect(judgement.surprise).toBeUndefined();
	});

	it("does not compare an inline prediction when the world model could not run", () => {
		const judgement = judgeStep(
			0,
			{ tool: "read", predict: "ok" },
			{ stale: true, error: "ReferenceError: x is not defined" },
			succeeded,
		);
		expect(judgement.surprise).toBeUndefined();
		expect(judgement.notices.join("\n")).toContain("could not be run");
	});

	it("checks nothing when neither the model nor the step predicts", () => {
		const judgement = judgeStep(0, { tool: "bash" }, { stale: false, skipped: true, observed: "exit=0" }, succeeded);
		expect(judgement.surprise).toBeUndefined();
		expect(judgement.notices).toEqual([]);
	});
});
