import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The global dreaming switch and the `models` list K8's `dreaming` option takes (#1499 D6: on by default). */
export interface DreamingSetting {
  readonly enabled: boolean;
  /** Host model template names, preferred first. */
  readonly models: readonly string[];
}

export interface HostSettings { readonly dreaming: DreamingSetting }

export const DEFAULT_SETTINGS: HostSettings = { dreaming: { enabled: true, models: [] } };

export class SettingsDamagedError extends Error {
  constructor(file: string, detail: string) {
    super(`Settings file ${file} is damaged: ${detail}`);
    this.name = 'SettingsDamagedError';
  }
}

function parse(file: string, text: string): HostSettings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SettingsDamagedError(file, 'not JSON');
  }
  const dreaming = (value as { dreaming?: { enabled?: unknown; models?: unknown } } | null)?.dreaming;
  if (typeof dreaming?.enabled !== 'boolean' || !Array.isArray(dreaming.models)
    || dreaming.models.some(model => typeof model !== 'string' || model === '')) {
    throw new SettingsDamagedError(file, 'dreaming must be { enabled: boolean, models: non-empty strings }');
  }
  return { dreaming: { enabled: dreaming.enabled, models: dreaming.models as string[] } };
}

/** The user's settings in one JSON file beside the Host stores. A missing file is the defaults; a damaged one stops the Host. */
export function settingsStore(file: string) {
  return {
    async read(): Promise<HostSettings> {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SETTINGS;
        throw error;
      }
      return parse(file, text);
    },
    /** Replaces the file atomically; a model list with a duplicate or empty name is refused rather than trimmed. */
    async setDreaming(dreaming: DreamingSetting): Promise<HostSettings> {
      if (new Set(dreaming.models).size !== dreaming.models.length || dreaming.models.some(model => model === '')) {
        throw new RangeError('dreaming.models must be unique, non-empty names');
      }
      const next: HostSettings = { dreaming: { enabled: dreaming.enabled, models: [...dreaming.models] } };
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, file);
      return next;
    },
  };
}

/** K8's `dreaming` option for these settings: `false` turns dreaming off for the whole Host. */
export const dreamingOption = (setting: DreamingSetting): { models: readonly string[] } | false =>
  setting.enabled ? { models: setting.models } : false;
