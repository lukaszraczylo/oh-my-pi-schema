import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SchemaRuntime } from "@oh-my-pi/pi-coding-agent/schema/state";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SchemaBacktestTool, SchemaModelTool, SchemaPlanTool } from "@oh-my-pi/pi-coding-agent/tools/schema";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// These cases run world models through the real JS eval VM and drive real `write` calls
// through `schema_commit`. The regressions they defend are sessions that cannot make a
// change at all: on a cold start, after one failed edit, or against a failing model.

let workspace: string;

function makeSession(overrides: Partial<Record<SettingPath, unknown>> = {}, runId = "run-a"): ToolSession {
	return {
		cwd: workspace,
		hasUI: false,
		enableLsp: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => runId,
		settings: Settings.isolated({ "schema.enabled": true, ...overrides }),
	} as unknown as ToolSession;
}

function bodyOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function worldModelPath(): string {
	return path.join(workspace, ".omp", "schema", "world_model.js");
}

/** What any agent does before its first change: look around. */
async function explore(runtime: SchemaRuntime): Promise<void> {
	await runtime.record("read", { path: "README.md" }, { ok: true, text: "# project" });
	await runtime.record("grep", { pattern: "attack" }, { ok: true, text: "src/a.ts:12: attack()" });
	await runtime.record("bash", { command: "bun test" }, { ok: true, text: "3 pass 1 fail" });
}

/** A committed test run that the seed model declines to predict. Billable only when bash is gated. */
async function commitUnpredictedRun(runtime: SchemaRuntime): Promise<void> {
	await runtime.record("bash", { command: "bun test" }, { ok: true, text: "3 pass 0 fail" }, { committed: true });
}

async function commitTool(session: ToolSession) {
	const tool = (await createTools(session, ["read", "write"])).find(entry => entry.name === "schema_commit");
	if (!tool) throw new Error("schema_commit was not registered");
	return tool;
}

async function commitWrite(session: ToolSession, file: string, id = "commit") {
	return await (
		await commitTool(session)
	).execute(id, {
		rationale: "write one file",
		steps: [{ tool: "write", args: { path: file, content: "hello\n" } }],
	});
}

/** Mispredicts every recorded grep, so any timeline that holds one fails certification. */
const RED_MODEL = `
function initialState() { return { done: false }; }
function step(state, action) {
	if (action.tool === "grep") return { state: state, predict: "never" };
	if (action.tool === "write") return { state: { done: true }, predict: "ok" };
	return { state: state, predict: null };
}
function digest(observation) { return observation.ok ? "ok" : null; }
function isGoal(state) { return state.done; }
function actions(state) { return [{ tool: "write", args: {} }]; }
`;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omps-coverage-"));
});

afterEach(async () => {
	await removeWithRetries(workspace);
});

describe("cold start", () => {
	it("lets a fresh session commit its first write after exploring", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		await explore(runtime);

		const result = await commitWrite(session, "notes.txt");

		expect(bodyOf(result)).toContain("All 1 step(s) executed with 0 mispredictions");
		expect(await Bun.file(path.join(workspace, "notes.txt")).text()).toBe("hello\n");
		const committed = (await runtime.timeline.entries()).filter(entry => entry.committed);
		expect(committed.map(entry => [entry.tool, entry.predicted, entry.surprise === true])).toEqual([
			["write", "ok", false],
		]);
	}, 60_000);

	it("recovers from a failed write: the next strict commit still goes through", async () => {
		await fs.mkdir(path.join(workspace, "occupied"));
		const session = makeSession();

		const failed = await commitWrite(session, "occupied", "commit-1");
		expect(bodyOf(failed)).toContain("Plan voided after 1/1 step(s)");

		const next = await commitWrite(session, "notes.txt", "commit-2");
		expect(bodyOf(next)).toContain("All 1 step(s) executed with 0 mispredictions");
		expect(bodyOf(next)).toContain("GREEN");
	}, 60_000);

	it("upgrades an untouched earlier seed so an existing project predicts its writes", async () => {
		const earlierSeed = await Bun.file(path.join(import.meta.dir, "fixtures", "schema-seed-v1.js")).text();
		await Bun.write(worldModelPath(), earlierSeed);
		const session = makeSession();

		await commitWrite(session, "notes.txt");

		const committed = (await SchemaRuntime.for(session).timeline.entries()).filter(entry => entry.committed);
		expect(committed.map(entry => entry.predicted)).toEqual(["ok"]);
	}, 60_000);

	it("leaves an edited world model untouched", async () => {
		const edited = `${await Bun.file(path.join(import.meta.dir, "fixtures", "schema-seed-v1.js")).text()}\n// edited\n`;
		await Bun.write(worldModelPath(), edited);

		await commitWrite(makeSession(), "notes.txt");

		expect(await Bun.file(worldModelPath()).text()).toBe(edited);
	}, 60_000);
});

describe("coverage billing", () => {
	it("bills world-changing tools only, never reads or test runs sent through a commit", async () => {
		const session = makeSession();
		const runtime = SchemaRuntime.for(session);
		await explore(runtime);
		await runtime.record("read", { path: "a.ts" }, { ok: true, text: "a" }, { committed: true, predicted: "ok" });
		await commitUnpredictedRun(runtime);
		await runtime.record(
			"write",
			{ path: "a.ts" },
			{ ok: true, text: "Wrote a.ts" },
			{ committed: true, predicted: "ok" },
		);
		await new SchemaModelTool(session).execute("seed", { action: "read" });

		const body = bodyOf(await new SchemaBacktestTool(session).execute("backtest", {}));
		expect(body).toContain("coverage 1/1 world-changing (100%)");
		expect(body).toContain("GREEN");
	}, 60_000);

	it("waits for schema.coverageAfter world-changing transitions before enforcing the floor", async () => {
		const session = makeSession({ "schema.coverageAfter": 2, "schema.gateBash": true });
		const runtime = SchemaRuntime.for(session);
		await new SchemaModelTool(session).execute("seed", { action: "read" });
		await commitUnpredictedRun(runtime);
		expect((await runtime.requireCertification()).warnings).toEqual([]);

		await commitUnpredictedRun(runtime);
		await expect(runtime.requireCertification()).rejects.toThrow(
			/predicts 0 of 2 world-changing transitions[\s\S]*Unpredicted: bash ×2/,
		);
	}, 60_000);

	it("keeps earlier sessions off the bill, and re-bills a cached verdict when the scope changes", async () => {
		const earlier = SchemaRuntime.for(makeSession({ "schema.gateBash": true }, "run-earlier"));
		for (let run = 0; run < 3; run++) await commitUnpredictedRun(earlier);

		const current = makeSession({ "schema.gateBash": true, "schema.coverageAfter": 1 }, "run-current");
		const runtime = SchemaRuntime.for(current);
		await new SchemaModelTool(current).execute("seed", { action: "read" });
		expect((await runtime.requireCertification()).warnings).toEqual([]);

		current.settings.set("schema.coverageScope", "project");
		await expect(runtime.requireCertification()).rejects.toThrow(/predicts 0 of 3 world-changing transitions/);
	}, 60_000);
});

describe("guided mode", () => {
	it("reports certification problems as warnings instead of refusing", async () => {
		const session = makeSession({ "schema.mode": "guided", "schema.coverageAfter": 1, "schema.gateBash": true });
		const runtime = SchemaRuntime.for(session);
		await new SchemaModelTool(session).execute("seed", { action: "read" });
		await commitUnpredictedRun(runtime);

		const { warnings } = await runtime.requireCertification();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("guided mode: continuing anyway");
	}, 60_000);

	it("checks each committed step against a failing world model instead of reporting false surprises", async () => {
		const session = makeSession({ "schema.mode": "guided" });
		const runtime = SchemaRuntime.for(session);
		await runtime.record("grep", { pattern: "x" }, { ok: true, text: "1 match" });
		await new SchemaModelTool(session).execute("model", { action: "write", source: RED_MODEL, note: "red" });
		await Bun.write(path.join(workspace, "exists.txt"), "hi\n");

		const result = await (
			await commitTool(session)
		).execute("commit", {
			rationale: "change, then look",
			steps: [
				{ tool: "write", args: { path: "notes.txt", content: "hello\n" } },
				{ tool: "read", args: { path: "exists.txt" }, predict: "ok" },
			],
		});

		expect(bodyOf(result)).toContain("All 2 step(s) executed with 0 mispredictions");
		const committed = (await runtime.timeline.entries()).filter(entry => entry.committed);
		expect(committed.map(entry => [entry.tool, entry.predicted, entry.surprise === true])).toEqual([
			["write", "ok", false],
			["read", "ok", false],
		]);
	}, 60_000);

	it("searches a failing world model in guided mode and refuses in strict mode", async () => {
		const guided = makeSession({ "schema.mode": "guided" });
		await SchemaRuntime.for(guided).record("grep", { pattern: "x" }, { ok: true, text: "1 match" });
		await new SchemaModelTool(guided).execute("model", { action: "write", source: RED_MODEL, note: "red" });

		const body = bodyOf(await new SchemaPlanTool(guided).execute("plan", {}));
		expect(body).toContain("BFS: goal in 1 step(s)");
		expect(body).toContain("guided mode: continuing anyway");

		await expect(new SchemaPlanTool(makeSession()).execute("plan", {})).rejects.toThrow(
			/does not reproduce recorded reality/,
		);
	}, 60_000);
});

describe("failed commit step", () => {
	async function commitAfterFailingWrite(mode: "strict" | "guided") {
		await fs.mkdir(path.join(workspace, "occupied"));
		const session = makeSession({ "schema.mode": mode });
		const result = await (
			await commitTool(session)
		).execute("commit", {
			rationale: "two writes, the first cannot succeed",
			steps: [
				{ tool: "write", args: { path: "occupied", content: "a directory is not a file\n" } },
				{ tool: "write", args: { path: "second.txt", content: "second\n" } },
			],
		});
		return { body: bodyOf(result), secondWritten: await Bun.file(path.join(workspace, "second.txt")).exists() };
	}

	it("voids the rest of the plan in strict mode", async () => {
		const { body, secondWritten } = await commitAfterFailingWrite("strict");
		expect(body).toContain("Plan voided after 1/2 step(s). step 0 (write) failed:");
		expect(secondWritten).toBe(false);
	}, 60_000);

	it("records the surprise and keeps executing in guided mode", async () => {
		const { body, secondWritten } = await commitAfterFailingWrite("guided");
		expect(body).toContain("1 surprise(s) recorded (guided mode keeps going)");
		expect(secondWritten).toBe(true);
	}, 60_000);
});
