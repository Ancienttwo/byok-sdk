/** Team role checks as pure rules (#739 D1). They read only the Bot rows that the caller gives. */
export function activeBot<B extends { readonly archived: boolean }>(team: { readonly bots: Readonly<Record<string, B>> }, id: string): B {
  const bot = team.bots[id];
  if (!bot || bot.archived) throw new Error('Bot is archived or absent');
  return bot;
}
export function requireMain(team: { readonly bots: Readonly<Record<string, { readonly archived: boolean; readonly mainBot: boolean }>> }, actor: string): void {
  if (!activeBot(team, actor).mainBot) throw new Error('Main Bot role required');
}
