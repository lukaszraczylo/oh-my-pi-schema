The only channel from thinking to action. Everything that changes the world goes through here.

Give an ordered `steps` queue. Each step names a `tool`, its `args`, and optionally `predict` — the projection you expect that step's observation to produce.

What happens per step:

1. The tool runs for real.
2. The transition is appended to the append-only timeline.
3. The live model advances by one step and its projection is compared with what actually happened.
4. On the first mismatch, the rest of the queue is discarded and the counterexample is returned.

`world_model.js` is the authority on what will happen. If your `predict` disagrees with what the model predicts for that step, the plan stops: the belief you acted on was never written down. Encode it in `step()` first.

Reality outranks the model. A voided plan is not an error to retry: it is evidence. Take the counterexample back to `schema_model`, fix the belief it refutes, re-certify with `schema_backtest`, and search again.

The queue is re-certified when it finishes, so the next plan starts from a verdict that accounts for everything that just happened.
