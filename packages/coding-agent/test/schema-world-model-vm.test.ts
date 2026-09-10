import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SchemaRuntime } from "@oh-my-pi/pi-coding-agent/schema/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SchemaBacktestTool, SchemaModelTool, SchemaPlanTool } from "@oh-my-pi/pi-coding-agent/tools/schema";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// The world model is executed, not parsed: these cases run it through the real JS
// eval VM, which is the only way to prove a certification verdict means anything.
const WORLD_MODEL = `
function initialState() { return { failing: 2, patched: false }; }
function step(state, action) {
	if (action.tool === "bash") return { state: state, predict: "failing=" + state.failing };
	if (action.tool === "edit") return { state: { failing: 0, patched: true }, predict: "edited" };
	return { state: state, predict: null };
}
function digest(observation) { return observation.text.trim(); }
function isGoal(state) { return state.failing === 0; }
function actions(state) { return [{ tool: "edit", args: { path: "a.ts" } }]; }
`;

let workspace: string;

function makeSession(): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => `vm-${path.basename(workspace)}`,
		settings: Settings.isolated({ "schema.enabled": true, "schema.minCoverage": 0.3 }),
	} as unknown as ToolSession;
}

function bodyOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omps-vm-"));
});

afterEach(async () => {
	await removeWithRetries(workspace);
});

describe("world model execution", () => {
	it("seeds the scaffold on first read", async () => {
		const session = makeSession();
		const body = bodyOf(await new SchemaModelTool(session).execute("1", { action: "read" }));
		expect(body).toContain("world_model.js did not exist");
		expect(body).toContain("function step(state, action)");
		expect(await Bun.file(path.join(workspace, ".omp", "schema", "world_model.js")).text()).toContain("initialState");
	});

	it("certifies a model that reproduces the record and reports skipped entries", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		await runtime.record("bash", { cmd: "test" }, { ok: true, text: "failing=2" });
		await runtime.record("read", { path: "x" }, { ok: true, text: "irrelevant" });
		await new SchemaModelTool(session).execute("1", { action: "write", source: WORLD_MODEL, note: "encode counts" });

		const body = bodyOf(await new SchemaBacktestTool(session).execute("2", {}));
		expect(body).toContain("1/1 transitions fully correct");
		expect(body).toContain("1 skipped of 2 recorded");
		expect(body).toContain("GREEN");
	}, 60_000);

	it("localizes the transition a wrong model mispredicts", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		await runtime.record("bash", { cmd: "test" }, { ok: true, text: "failing=7" });
		await new SchemaModelTool(session).execute("1", { action: "write", source: WORLD_MODEL, note: "encode counts" });

		const body = bodyOf(await new SchemaBacktestTool(session).execute("2", {}));
		expect(body).toContain("NOT CERTIFIED");
		expect(body).toContain("mismatch at timeline entry 0 (bash)");
		expect(body).toContain("predicted: failing=2");
		expect(body).toContain("observed:  failing=7");
	}, 60_000);

	it("refuses to search an uncertified model", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		await runtime.record("bash", { cmd: "test" }, { ok: true, text: "failing=7" });
		await new SchemaModelTool(session).execute("1", { action: "write", source: WORLD_MODEL, note: "encode counts" });

		await expect(new SchemaPlanTool(session).execute("2", {})).rejects.toThrow(/does not reproduce recorded reality/);
	}, 60_000);

	it("searches the certified model for a plan that reaches is_goal", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		await runtime.record("bash", { cmd: "test" }, { ok: true, text: "failing=2" });
		await new SchemaModelTool(session).execute("1", { action: "write", source: WORLD_MODEL, note: "encode counts" });

		const body = bodyOf(await new SchemaPlanTool(session).execute("2", {}));
		expect(body).toContain("BFS: goal in 1 step(s)");
		expect(body).toContain('"tool": "edit"');
	}, 60_000);
});
