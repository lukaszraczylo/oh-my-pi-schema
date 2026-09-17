# schema_commit

> The predicted channel from thinking to action. Runs an ordered queue against the world; strict mode stops at the first misprediction, guided mode records it and continues.

## Source
- Entry: `packages/coding-agent/src/tools/schema.ts` (`SchemaCommitTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/schema-commit.md`
- Key collaborators:
  - `packages/coding-agent/src/schema/gate.ts` — wraps every tool; gated tools call `assertCommitChannel` unless a commit is in flight.
  - `packages/coding-agent/src/schema/runner.ts` — `openLiveModel` and `advanceLiveModel` check each step without replaying the whole history.
  - `packages/coding-agent/src/tools/tool-dispatch.ts` — `getSessionTool` resolves the tool for in-process dispatch.
  - `packages/coding-agent/src/schema/timeline.ts` — appends each executed transition.

## Registration / Visibility
- Tool metadata: `approval = "write"`, `strict = true`, `loadMode = "essential"`, `concurrency = "exclusive"` (no other tool call in the turn runs while a commit is open). Requires `schema.enabled = true`.
- The tools listed in `schema.gatedTools` (`edit`, `write`, `ast_edit` by default, plus `bash` when `schema.gateBash` is set) run only inside this tool in strict mode. Guided mode (`schema.mode guided`) lets them run directly, records them, and attaches advice to their result.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rationale` | `string` | Yes | Why this queue, in one line. |
| `steps` | `Array<{ tool, args, predict? }>` | Yes | Ordered actions. `predict` is the projection the caller expects that step's observation to produce. It is checked against reality only when `world_model.js` declines to predict the step. |

## Outputs
- A summary line: every step executed with no mispredictions, or the plan voided at step N with the reason.
- Any notices (for example, a declared projection the model declined to predict).
- The re-certification report produced after the queue finishes.

`details` carries `executed`, `requested`, `voided`, and a per-step outcome list including `match`, `predicted`, and `observed`. A voided queue also sets `isError`.

## Flow
1. `requireCertification` runs first. A red model, or one under `schema.minCoverage` once `schema.coverageAfter` committed transitions exist, refuses the queue in strict mode and returns warnings in guided mode.
2. `openLiveModel` replays the recorded history once and leaves the model live in the schema VM.
3. Per step: dispatch the tool through the registry, append the transition to the timeline, and advance the live model by that one action. If the VM lost the live state, the tool falls back to a full replay and retries the check.
4. The step is judged by `judgeStep`: the model's prediction when it has one, otherwise the step's own `predict`. A disagreement between the two is returned as a notice. A failed step without a matched prediction also counts as a surprise. A mispredicted step is recorded with `surprise: true` and `committed: true`; strict mode voids the rest of the queue, guided mode continues. When the world model cannot be run at all, the step is not checked against it and a notice says so.
5. The queue re-certifies at the end, so the next plan starts from a verdict that accounts for everything that just happened.

## Failure modes
- A step naming a `schema_*` tool is rejected: deliberation changes nothing and does not belong in a queue.
- `checkpoint` and `rewind` are rejected for the same reason the eval bridge rejects them — they are recognized only as direct tool calls.
- An empty `steps` array is a `ToolError`.
