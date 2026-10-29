import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentMemoryError, AgentMemoryValidationError, validateAgentMemoryPath } from '../agent-memory';

describe('validateAgentMemoryPath', () => {
  it('admits MEMORY.md and safe notes paths unchanged', () => {
    expect(validateAgentMemoryPath('MEMORY.md')).toBe('MEMORY.md');
    expect(validateAgentMemoryPath('notes/pricing.md')).toBe('notes/pricing.md');
    expect(validateAgentMemoryPath('notes/a/b-c_d.e.md')).toBe('notes/a/b-c_d.e.md');
  });

  it('refuses a leading slash exactly as POSIX absoluteness did', () => {
    for (const value of ['/', '/MEMORY.md', '/notes/x.md', '//notes/x.md']) {
      expect(() => validateAgentMemoryPath(value)).toThrow('memory path must name exactly one file');
    }
    // A slash anywhere but first is not absolute; it reaches the notes rule instead.
    expect(() => validateAgentMemoryPath('notes//x.md')).toThrow('memory path must be MEMORY.md or notes/<safe-relative>.md');
    expect(() => validateAgentMemoryPath('C:/notes/x.md')).toThrow('memory path must be MEMORY.md or notes/<safe-relative>.md');
  });

  it('refuses backslashes, NUL, globs, traversal, internal state and secret-like names', () => {
    expect(() => validateAgentMemoryPath('\\notes\\x.md')).toThrow('memory path is invalid');
    expect(() => validateAgentMemoryPath('notes/x\u0000.md')).toThrow('memory path is invalid');
    expect(() => validateAgentMemoryPath('notes/*.md')).toThrow('memory path must name exactly one file');
    for (const value of ['notes/../MEMORY.md', 'notes/.byok/x.md', 'notes/api-key.md', 'notes/con.md', 'notes/x.txt', 'other/x.md']) {
      expect(() => validateAgentMemoryPath(value)).toThrow('memory path must be MEMORY.md or notes/<safe-relative>.md');
    }
    expect(() => validateAgentMemoryPath(42)).toThrow(AgentMemoryValidationError);
  });

  it('throws the validation subclass of the memory base error', () => {
    try { validateAgentMemoryPath(''); } catch (error) {
      expect(error).toBeInstanceOf(AgentMemoryValidationError);
      expect(error).toBeInstanceOf(AgentMemoryError);
      expect((error as Error).name).toBe('AgentMemoryValidationError');
      return;
    }
    throw new Error('expected a refusal');
  });

  it('imports no node: builtin', () => {
    const source = readFileSync(new URL('../agent-memory.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+'node:|require\('node:|import\('node:/);
  });
});
