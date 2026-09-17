The predicted channel from thinking to action. In strict mode (the default) everything that changes the world goes through here.

Give an ordered `steps` queue. Each step names a `tool`, its `args`, and optionally `predict` — the projection you expect that step's observation to produce.

What happens per step:

1. The tool runs for real.
2. The transition is appended to the append-only timeline.
3. The live model advances by one step and its projection is compared with what actually happened.
4. On the first mismatch, strict mode discards the rest of the queue and returns the counterexample. Guided mode records it and keeps going.

`world_model.js` is the authority when it predicts a step: your `predict` is only compared with it, and a disagreement comes back as advice. When the model declines to predict a step, your `predict` is checked against reality instead. That helps while the model is still thin, but encode the belief in `step()` so certification covers it next time.

Reality outranks the model. A voided plan is not an error to retry: it is evidence. Take the counterexample back to `schema_model`, fix the belief it refutes, re-certify with `schema_backtest`, and search again.

The queue is re-certified when it finishes, so the next plan starts from a verdict that accounts for everything that just happened.
