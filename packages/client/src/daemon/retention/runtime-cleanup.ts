import { TreeCleanup } from './tree-cleanup';
/** Runtime release evidence survives every partial pass. */
export const RuntimeCleanup = { create: (target: string): Promise<TreeCleanup | undefined> => TreeCleanup.create(target, true) };
export type RuntimeCleanup = TreeCleanup;
