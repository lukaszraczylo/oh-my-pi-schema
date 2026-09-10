Replay `world_model.js` over every recorded transition and report where it disagrees with reality.

This is certification. It answers one question exactly: does your theory reproduce everything you have actually observed? The record survives compaction, so a green backtest lets you trust the model in place of re-testing the world.

The report gives `matched/checked` exact, the number skipped (entries the model declined to predict), coverage, and up to three pointed mismatches with the predicted and observed projections side by side.

A mismatch is not a failure, it is a location. Use it to find the wrong belief. If several revisions in a row patch rules without changing what the state is made of, change the representation instead.

Run this after every `schema_model write`, and whenever new actions have landed on the timeline.
