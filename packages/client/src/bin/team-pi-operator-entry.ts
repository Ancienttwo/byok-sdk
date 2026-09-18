/** Private official-CLI token, deliberately absent from reserved helper/runtime tables. */
export const PI_TEAM_OPERATOR_TOKEN = '__byok_pi_team_operator';

export interface PiTeamOperatorInvocation {
  readonly command: string;
  readonly args: readonly string[];
}
