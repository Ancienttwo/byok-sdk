export const fixtureScenarios = ['question', 'secret', 'withdrawn', 'exit', 'two-questions', 'control-text', 'approval'] as const;
export type FixtureScenario = typeof fixtureScenarios[number];
