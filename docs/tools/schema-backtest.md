# schema_backtest

> Replay `world_model.js` over every recorded transition and report where the theory disagrees with reality.

## Source
- Entry: `packages/coding-agent/src/tools/schema.ts` (`SchemaBacktestTool`, `formatBacktest`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/schema-backtest.md`
- Key collaborators:
  - `packages/coding-agent/src/schema/runner.ts` — `backtestWorldModel` runs the model in the JS eval VM.
  - `packages/coding-agent/src/schema/runtime/harness/template.js` — the replay driver appended after the model.
  - `packages/coding-agent/src/schema/timeline.ts` — supplies the complete `(action, observation)` history.

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`. Requires `schema.enabled = true`.
- The tool changes nothing outside the agent's own state; it is not gated by the commit channel and is never recorded on the timeline.

## Inputs
No parameters.

## Outputs
Two summary lines plus up to three mismatches:

```
backtest [all transitions]: 12/12 transitions fully correct; 0 mismatch(es), 3 skipped of 15 recorded.
coverage 80% · state keys [buildGreen, failing] · is_goal false · GREEN
```

Each mismatch names the timeline entry and tool, then the predicted and observed projections. `details.report` carries the full `BacktestReport`.

## Flow
1. The VM is reset, then the code cell is `payload + world_model.js + harness`. A reset is mandatory: a stale `step` from an earlier revision would otherwise certify a model the agent no longer has.
2. The harness replays from `initialState()`, applying `step(state, action)` per entry. `predict: null` counts as skipped; anything else is compared verbatim against `digest(observation)`.
3. The verdict is cached against the model hash and the timeline length, and the newest ledger revision is stamped with the state keys, the green flag, and the mismatch count.

## Failure modes
- A model that throws in `initialState`, `step`, `digest`, or `isGoal` reports the throwing entry in `report.error` and is not green.
- If the model prints nothing the runner recognizes, `WorldModelRunError` surfaces the raw cell output so the syntax error is visible.
