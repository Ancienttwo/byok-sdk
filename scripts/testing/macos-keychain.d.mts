export interface TestKeychain { readonly path: string; dispose(): Promise<void>; }
export function createTestKeychain(): Promise<TestKeychain>;
