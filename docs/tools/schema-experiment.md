# schema_experiment

> Rank candidate actions by how many rival hypotheses each one separates.

## Source
- Entry: `packages/coding-agent/src/tools/schema.ts` (`SchemaExperimentTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/schema-experiment.md`
- Key collaborators:
  - `packages/coding-agent/src/schema/experiment.ts` — `rankExperiments`, the pure ranking function.
  - `packages/coding-agent/src/schema/store.ts` — persists the hypothesis set in `ledger.json`.

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`. Requires `schema.enabled = true`.
- The tool performs no environment interaction and is never recorded on the timeline.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `hypotheses` | `Array<{ id, claim, predicts }>` | Yes | At least two. `predicts` maps a candidate action label to the projection that hypothesis expects. |
| `candidates` | `string[]` | No | Actions to rank. Defaults to every action any hypothesis predicts. |

## Outputs
One block per candidate — `splits`, `ties`, any silent hypotheses, and the predicted outcomes grouped by value — followed by the verdict naming the most discriminating candidate, or a statement that no candidate separates any pair.

`details` carries `best` and the number of ranked candidates.

## Flow
1. The hypothesis set replaces whatever is in the ledger, so a rule killed by evidence stays killed.
2. Each candidate is scored by the number of hypothesis pairs that predict different outcomes for it. Ties break on fewer silent hypotheses, then on the action label.
3. Ranking is deterministic and needs no world model, so it works before a model is certified.

## Failure modes
- Fewer than two hypotheses is a `ToolError`: an experiment is only useful when it separates rivals.
- No candidate actions to rank is a `ToolError`.
