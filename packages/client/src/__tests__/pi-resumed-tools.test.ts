import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { resetResumedPiTools } from '../bin/pi-session-runtime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function dirs(): { cwd: string; agentDir: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-resumed-tools-'));
  roots.push(root);
  return { cwd: mkdtempSync(join(root, 'cwd-')), agentDir: mkdtempSync(join(root, 'agent-')), sessionDir: mkdtempSync(join(root, 'sessions-')) };
}

const tool = (name: string) => ({
  name, label: name, description: name, parameters: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }),
});

/** Opens a session as the SDK hosts do: default tools, extension tools registered at load. */
async function open(cwd: string, agentDir: string, sessionManager: SessionManager, names: string[], excludeTools?: string[]) {
  const extension: ExtensionFactory = (pi) => { for (const name of names) pi.registerTool(tool(name) as never); };
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [extension] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager, settingsManager, resourceLoader, excludeTools });
  return { session, settingsManager };
}

/** A previous open's transcript that declared the default tools plus `mcp_A`. */
function previousTranscript(cwd: string, sessionDir: string): string {
  const first = SessionManager.create(cwd, sessionDir);
  first.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() });
  first.appendMessage({
    role: 'system', content: '', timestamp: Date.now(),
    toolsAdded: ['read', 'bash', 'edit', 'write', 'mcp_A'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
  } as never);
  return first.getSessionFile()!;
}

describe('resumed Pi session tools (Pi 1.3)', () => {
  it('offers a tool this open registers that the resumed transcript did not declare', async () => {
    const { cwd, agentDir, sessionDir } = dirs();
    const file = previousTranscript(cwd, sessionDir);
    const { session, settingsManager } = await open(cwd, agentDir, SessionManager.open(file, sessionDir), ['mcp_A', 'mcp_B']);
    try {
      // Native Pi 1.3 restores only the transcript's loadout.
      expect(session.getActiveToolNames()).not.toContain('mcp_B');
      resetResumedPiTools(session, settingsManager, cwd);
      expect(session.getActiveToolNames().sort()).toEqual(['bash', 'edit', 'mcp_A', 'mcp_B', 'read', 'write']);
    } finally {
      session.dispose();
    }
  });

  it('keeps this open\'s excludeTools on a resumed session', async () => {
    const { cwd, agentDir, sessionDir } = dirs();
    const file = previousTranscript(cwd, sessionDir);
    const { session, settingsManager } = await open(cwd, agentDir, SessionManager.open(file, sessionDir), ['mcp_A', 'mcp_B'], ['bash', 'mcp_A']);
    try {
      resetResumedPiTools(session, settingsManager, cwd);
      expect(session.getActiveToolNames().sort()).toEqual(['edit', 'mcp_B', 'read', 'write']);
    } finally {
      session.dispose();
    }
  });

  it('leaves a new session unchanged', async () => {
    const { cwd, agentDir, sessionDir } = dirs();
    const { session, settingsManager } = await open(cwd, agentDir, SessionManager.create(cwd, sessionDir), ['mcp_A', 'mcp_B']);
    try {
      const before = session.getActiveToolNames();
      resetResumedPiTools(session, settingsManager, cwd);
      expect(session.getActiveToolNames()).toEqual(before);
      expect(before.sort()).toEqual(['bash', 'edit', 'mcp_A', 'mcp_B', 'read', 'write']);
    } finally {
      session.dispose();
    }
  });
});
