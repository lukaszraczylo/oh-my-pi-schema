# schema_plan

> Breadth-first search inside the certified world model for a sequence of actions that reaches `isGoal`.

## Source
- Entry: `packages/coding-agent/src/tools/schema.ts` (`SchemaPlanTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/schema-plan.md`
- Key collaborators:
  - `packages/coding-agent/src/schema/runner.ts` — `planInWorldModel`.
  - `packages/coding-agent/src/schema/runtime/harness/template.js` — the search runs there, over the replayed final state.
  - `packages/coding-agent/src/schema/state.ts` — `requireCertification` refuses an uncertified or under-covered model.

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`. Requires `schema.enabled = true`.
- Search spends no environment actions, so the tool is never gated or recorded.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxNodes` | `number` | No | Node budget; defaults to `schema.maxSearchNodes` (20000). |
| `maxDepth` | `number` | No | Longest sequence considered; defaults to `schema.maxPlanDepth` (64). |

## Outputs
- Found: `BFS: goal in N step(s); expanded X nodes, Y distinct states.` followed by the action sequence as JSON.
- Not found: the same counters, whether the node budget or the search space ran out, and a reminder that search is complete only relative to this model — a missing object, state variable, or transition is the likely cause.

`details.plan` carries the `PlanReport`.

## Flow
1. `requireCertification` runs (or reuses) a backtest. A red verdict, or coverage below `schema.minCoverage`, raises a `ToolError` naming the shortfall.
2. The harness replays the timeline, then searches from that final state over `actions(state)` and `step(state, action)`, deduplicating with `key(state)`.
3. The returned sequence is the input to `schema_commit`, one step at a time, each carrying its projection.

## Failure modes
- `world_model.js` without `isGoal` or `actions` cannot be searched; the tool raises the harness error verbatim.
- The harness refuses to search when the replay is not green, so a stale certification can never silently produce a plan.
