import { compareCodeUnits } from '../../util/compare-code-units.js';
import type { McpHubCatalog } from './catalog.js';
import { hubText } from './protocol.js';

const TOP_K = 5;
const MAX_SEARCH_RESULT_BYTES = 256 * 1024;
const HAN_WORD = /^\p{Script=Han}+$/u;

function words(value: string): string[] {
  return value.normalize('NFKC')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLowerCase().match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+/gu) ?? [];
}

function coverage(query: readonly string[], tokens: readonly string[]): number {
  return query.filter((word) => tokens.some((token) => word === token
    || (HAN_WORD.test(word) && HAN_WORD.test(token) && token.includes(word)))).length;
}

export function searchMcpHubCatalog(catalog: McpHubCatalog, query: string): Record<string, unknown> {
  const queryWords = words(query);
  if (queryWords.length === 0) return hubText('[]');
  const queryName = queryWords.join(' ');
  const distinct = [...new Set(queryWords)];
  const matches = [...catalog.values()].flatMap(({ serverName, tools }) => tools.flatMap((tool) => {
    const name = words(tool.name);
    const nameMatches = coverage(distinct, name);
    const descriptionMatches = coverage(distinct, words(tool.description));
    const rank = name.join(' ') === queryName ? 3 : nameMatches > 0 ? 2 : descriptionMatches > 0 ? 1 : 0;
    if (rank === 0) return [];
    return [{ server: serverName, tool, rank, coverage: rank === 1 ? descriptionMatches : nameMatches }];
  }));
  matches.sort((a, b) => b.rank - a.rank || b.coverage - a.coverage
    || compareCodeUnits(a.server, b.server) || compareCodeUnits(a.tool.name, b.tool.name));

  const rows: string[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(hubText('[]')), 'utf8');
  for (const { server, tool } of matches) {
    const row = JSON.stringify({ server, tool: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') - 2;
    const total = bytes + rowBytes + (rows.length === 0 ? 0 : 1);
    if (total > MAX_SEARCH_RESULT_BYTES) continue;
    rows.push(row);
    bytes = total;
    if (rows.length === TOP_K) break;
  }
  if (matches.length > 0 && rows.length === 0) return hubText('Matching tools exceed the search result size limit.', true);
  return hubText(`[${rows.join(',')}]`);
}
