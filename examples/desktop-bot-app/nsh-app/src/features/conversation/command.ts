import { errorText } from "../../statusCopy.ts";
import { signal } from "nsh";
import { toBridgeCallError } from "../../bridge.ts";

export interface Command {
  readonly busy: () => boolean;
  readonly error: () => string | null;
  /** Runs one bridge command; true once it succeeded. Its failure shows through `error`, never dropped. */
  readonly run: (command: () => Promise<unknown>) => Promise<boolean>;
}

/** The busy and failure state of one control's bridge commands (`useCommand` of the Electron renderer). */
export function createCommand(): Command {
  const busy = signal(false);
  const error = signal<string | null>(null);
  return {
    busy: () => busy(),
    error: () => {
      const code = error();
      return code === null ? null : errorText(code);
    },
    run: async (command) => {
      busy.set(true);
      error.set(null);
      try {
        await command();
        return true;
      } catch (cause) {
        error.set(toBridgeCallError(cause).code);
        return false;
      } finally {
        busy.set(false);
      }
    },
  };
}
