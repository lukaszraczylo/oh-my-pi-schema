# schema_model

> Read, revise, and inspect `world_model.js` — the executable theory of the task the Schema loop certifies before acting.

## Source
- Entry: `packages/coding-agent/src/tools/schema.ts` (`SchemaModelTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/schema-model.md`
- Key collaborators:
  - `packages/coding-agent/src/schema/store.ts` — reads and writes the model, notes, and revision ledger; counts epicycles.
  - `packages/coding-agent/src/schema/paths.ts` — resolves `.omp/schema/` (or `schema.stateDir`).
  - `packages/coding-agent/src/schema/state.ts` — holds the certification verdict and the voided-plan marker.
  - `packages/coding-agent/src/schema/runtime/seed/template.js` — scaffold written on first read.

## Registration / Visibility
- Tool metadata: `approval` is `write` when `source` or `notes` is present and `read` otherwise; `strict = true`, `loadMode = "essential"`.
- Registration requires `schema.enabled = true` (default `true`).
- `createTools` force-includes the five `schema_*` tools into any explicit tool list while the loop is on, including restricted subagent lists: a session that can call a gated tool but not `schema_commit` would have no channel to the world.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"status" \| "read" \| "write" \| "notes" \| "timeline"` | No | Defaults to `status`. |
| `source` | `string` | For `write` | Replacement `world_model.js` body. |
| `note` | `string` | For `write` | One line on what changed in this revision and why. Recorded in the ledger. |
| `notes` | `string` | No | Replacement `notes.md` text. Omit under `action: "notes"` to read instead. |
| `limit` | `number` | No | Timeline entries to show under `action: "timeline"` (default 20). |

## Outputs
- `status` — model path, revision count and last note, timeline length, the cached certification verdict (or a prompt to run `schema_backtest`), hypothesis count, any voided plan, and the epicycle streak.
- `read` — `world_model.js` and `notes.md`, prefixed with a seeding notice when the scaffold was just created.
- `write` — the new revision number and byte count, plus a reminder that the previous certification no longer applies.
- `notes` — the notebook text, or `notes.md saved.`
- `timeline` — total recorded transitions and a one-line-per-entry tail (`#seq tool (ok|error) [SURPRISE] :: first line`).

`details` carries `action` and, where applicable, `revision`, `epicycles`, and `timelineLength`.

## Flow
1. `write` replaces the program on disk and appends a revision to `ledger.json`. It clears any voided-plan marker, because the belief that voided it has just been revised.
2. A write invalidates the cached certification: `SchemaRuntime.certification()` compares the model hash and the timeline length, so both a model edit and a new action force a fresh `schema_backtest`.
3. `status` recomputes the epicycle streak with `countEpicycles`: consecutive revisions whose backtest stayed red while the state representation (the sorted top-level state keys) did not change. Past `schema.epicycleThreshold`, the status line advises changing the representation instead of the rule.

## Failure modes
- `write` without `source` or without `note` is a `ToolError`; the note is required so the ledger stays readable.
- Called while `schema.enabled` is `false`, every `schema_*` tool refuses with the setting to flip.
