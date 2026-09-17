import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { SchemaAction, SchemaObservation, TimelineEntry } from "./types";

/** Longest observation text kept per entry. Keeps the ledger replayable without unbounded growth. */
export const MAX_OBSERVATION_BYTES = 16_384;

/** Truncate an observation body, marking the cut so a projection can never match by accident. */
export function clampObservation(text: string): string {
	if (text.length <= MAX_OBSERVATION_BYTES) return text;
	return `${text.slice(0, MAX_OBSERVATION_BYTES)}\n…[truncated ${text.length - MAX_OBSERVATION_BYTES} chars]`;
}

const timelines = new Map<string, Timeline>();

/**
 * The append-only record of everything that actually happened.
 *
 * The agent may revise its theory and its notes at will, but it can never alter what
 * it observed or what it did. Because the record outlives both the context window and
 * compaction, a model certified against it can be trusted in place of re-testing
 * reality.
 */
export class Timeline {
	#path: string;
	#entries: TimelineEntry[] = [];
	#loaded = false;
	/** Serializes appends so two writers in one process cannot mint the same `seq`. */
	#tail: Promise<unknown> = Promise.resolve();

	constructor(filePath: string) {
		this.#path = filePath;
	}

	/**
	 * One timeline per file per process. Subagents share the parent's record, which is
	 * what lets a later run refute a rule that only coincidentally fit an earlier one.
	 */
	static for(filePath: string): Timeline {
		const existing = timelines.get(filePath);
		if (existing) return existing;
		const created = new Timeline(filePath);
		timelines.set(filePath, created);
		return created;
	}

	get path(): string {
		return this.#path;
	}

	/** Read the file once per process; later appends keep the cache in step. */
	async load(): Promise<TimelineEntry[]> {
		if (this.#loaded) return this.#entries;
		try {
			const text = await Bun.file(this.#path).text();
			const parsed: unknown = Bun.JSONL.parse(text);
			this.#entries = Array.isArray(parsed) ? parsed.filter(isTimelineEntry) : [];
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Schema timeline unreadable; starting a fresh in-memory view", {
					path: this.#path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			this.#entries = [];
		}
		this.#loaded = true;
		return this.#entries;
	}

	async length(): Promise<number> {
		return (await this.load()).length;
	}

	async entries(): Promise<readonly TimelineEntry[]> {
		return await this.load();
	}

	/** Append one real transition. Returns the stored entry. */
	async append(record: {
		run: string;
		tool: string;
		args: unknown;
		observation: SchemaObservation;
		predicted?: string | null;
		surprise?: boolean;
		committed?: boolean;
	}): Promise<TimelineEntry> {
		const queued = this.#tail.then(() => this.#appendNow(record));
		// Keep the chain alive after a rejection so one failed append cannot wedge the rest.
		this.#tail = queued.catch(() => undefined);
		return await queued;
	}

	async #appendNow(record: {
		run: string;
		tool: string;
		args: unknown;
		observation: SchemaObservation;
		predicted?: string | null;
		surprise?: boolean;
		committed?: boolean;
	}): Promise<TimelineEntry> {
		const entries = await this.load();
		const entry: TimelineEntry = {
			seq: entries.length,
			ts: Date.now(),
			run: record.run,
			tool: record.tool,
			args: record.args,
			observation: {
				ok: record.observation.ok,
				text: clampObservation(record.observation.text),
				details: record.observation.details,
			},
			...(record.predicted === undefined ? {} : { predicted: record.predicted }),
			...(record.surprise ? { surprise: true } : {}),
			...(record.committed ? { committed: true } : {}),
		};
		entries.push(entry);
		try {
			await fs.mkdir(path.dirname(this.#path), { recursive: true });
			await fs.appendFile(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
		} catch (error) {
			logger.error("Schema timeline append failed", {
				path: this.#path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return entry;
	}

	/** Project the timeline into the `(action, observation)` pairs the world model replays. */
	async transitions(): Promise<
		Array<{ action: SchemaAction; observation: SchemaObservation; recorded: TimelineEntry }>
	> {
		const entries = await this.load();
		return entries.map((entry, index) => ({
			action: { run: entry.run, index, tool: entry.tool, args: entry.args },
			observation: entry.observation,
			recorded: entry,
		}));
	}
}

function isTimelineEntry(value: unknown): value is TimelineEntry {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.seq === "number" &&
		typeof record.tool === "string" &&
		typeof record.run === "string" &&
		record.observation !== null &&
		typeof record.observation === "object"
	);
}
