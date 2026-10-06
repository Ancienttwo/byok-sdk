export const fixtureScenarios = ['approval', 'question', 'secret', 'withdrawn', 'exit', 'two-approvals', 'control-text'] as const;
export type FixtureScenario = typeof fixtureScenarios[number];
