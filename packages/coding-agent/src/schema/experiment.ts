import type { ExperimentRanking, Hypothesis } from "./types";

/**
 * Rank candidate actions by how much uncertainty each one resolves.
 *
 * The agent does not act only to reach the goal; it acts to find out what the world
 * is. When several rules still fit the record, the useful action is the one whose
 * outcomes the surviving hypotheses disagree about. Because excess actions are the
 * expensive resource, the best experiment resolves the most uncertainty per action.
 */
export function rankExperiments(
	hypotheses: readonly Hypothesis[],
	candidates?: readonly string[],
): ExperimentRanking[] {
	const actions =
		candidates && candidates.length > 0
			? [...new Set(candidates)]
			: [...new Set(hypotheses.flatMap(hypothesis => Object.keys(hypothesis.predicts)))];

	const rankings = actions.map(action => {
		const outcomes: Record<string, string[]> = {};
		const silent: string[] = [];
		for (const hypothesis of hypotheses) {
			const predicted = hypothesis.predicts[action];
			if (predicted === undefined) {
				silent.push(hypothesis.id);
				continue;
			}
			(outcomes[predicted] ??= []).push(hypothesis.id);
		}
		const groups = Object.values(outcomes);
		const predicting = groups.reduce((sum, group) => sum + group.length, 0);
		const totalPairs = (hypotheses.length * (hypotheses.length - 1)) / 2;
		const samePairs = groups.reduce((sum, group) => sum + (group.length * (group.length - 1)) / 2, 0);
		const splits = (predicting * (predicting - 1)) / 2 - samePairs;
		return { action, splits, ties: totalPairs - splits, silent, outcomes } satisfies ExperimentRanking;
	});

	return rankings.sort(
		(left, right) =>
			right.splits - left.splits ||
			left.silent.length - right.silent.length ||
			left.action.localeCompare(right.action),
	);
}
