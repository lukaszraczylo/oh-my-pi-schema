Search inside the certified world model for a sequence of actions that reaches `isGoal`.

Breadth-first search over `actions(state)` and `step(state, action)`, starting from the state the model ends the recorded history in. It spends no real actions, so being wrong here is free.

In strict mode this requires a green backtest; guided mode searches anyway and returns the warning. Search is only complete relative to the model it runs over: over the wrong model, exhaustive search returns a confident wrong answer. That is why certification comes first.

Returns the action sequence, nodes expanded, distinct states, and whether the node budget ran out. Hand the sequence to `schema_commit`, attaching the projection you expect for each step.
