/** Disposable synthetic probe extension; no production binding or message store. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
export default function (pi: any) {
  const root = process.env.BYOK_NOTIFY_PROBE_ROOT!;
  if (!root?.startsWith('/tmp/byok-notify-probe-') || !root.endsWith('/pi')) throw new Error('probe root required');
  let context: any, timer: ReturnType<typeof setInterval>, lastId = '', pendingConfirm = false;
  let release: (() => void) | undefined;
  const log = (data: any) => appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ ts: Date.now(), sessionId: context?.sessionManager.getSessionId(), ...data }) + '\n', { mode: 0o600 });
  const snapshot = () => ({ editor: context.ui.getEditorText(), idle: context.isIdle(), pendingConfirm });
  const prompt = (label: string, tool = 'probe_record') => `Call only ${tool} with label "${label}" once. Then finish with DONE. This is a synthetic probe, do not call other tools.`;
  const confirm = async (label: string, ctx: any) => {
    pendingConfirm = true; log({ event: 'confirm_open', label, ...snapshot() });
    const answer = await ctx.ui.confirm('Synthetic probe approval', 'Approve the synthetic record?');
    pendingConfirm = false; log({ event: 'confirm_resolved', label, answer, ...snapshot() });
    return answer;
  };
  for (const name of ['probe_gate', 'probe_approval', 'probe_record']) pi.registerTool({
    name, label: name, description: 'Synthetic-only notification probe. Record the supplied label.',
    parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      log({ event: 'tool_enter', tool: name, label: params.label, ...snapshot() });
      if (name === 'probe_gate') await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('gate deadline')), 90000); release = () => { clearTimeout(t); resolve(); }; });
      if (name === 'probe_approval' && !(await confirm(params.label, ctx))) return { content: [{ type: 'text', text: 'Explicitly declined; no record action performed.' }], details: { declined: true } };
      log({ event: 'tool_exit', tool: name, label: params.label, ...snapshot() });
      return { content: [{ type: 'text', text: 'Recorded ' + params.label }], details: {} };
    },
  });
  pi.on('session_start', (_event: any, ctx: any) => {
    context = ctx; log({ event: 'ready', ...snapshot() });
    timer = setInterval(() => {
      const file = path.join(root, 'request.json'); if (!existsSync(file)) return;
      const request = JSON.parse(readFileSync(file, 'utf8')); if (request.id === lastId) return; lastId = request.id;
      if (request.op === 'draft') context.ui.setEditorText('HUMAN_DRAFT_SENTINEL');
      else if (request.op === 'notify') { log({ event: 'notify_before', label: request.label, ...snapshot() }); pi.sendUserMessage(prompt(request.label, request.tool), { deliverAs: 'followUp' }); }
      else if (request.op === 'release') { release?.(); release = undefined; }
      else if (request.op === 'confirm') void confirm('idle-dialog', context);
      log({ event: 'request_handled', id: request.id, op: request.op, label: request.label, ...snapshot() });
    }, 50);
  });
  pi.on('agent_settled', () => log({ event: 'agent_settled', ...snapshot() }));
  pi.on('session_shutdown', () => clearInterval(timer));
}
