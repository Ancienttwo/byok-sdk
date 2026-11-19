/** The test-runner operations used by the shared collaboration vectors. */
export interface VectorMatchers {
  readonly not: VectorMatchers;
  readonly rejects: VectorMatchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: Record<string, unknown> | readonly unknown[]): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeInstanceOf(expected: Function): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toContain(expected: unknown): void;
  toContainEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
  toHaveProperty(path: string, value?: unknown): void;
  toThrow(expected?: string | RegExp | Function): void;
}
export interface VectorTestApi {
  describe(name: string, body: () => void): void;
  it: {
    (name: string, body: () => void | Promise<void>, timeout?: number): void;
    each<T>(cases: readonly T[]): (name: string, body: (...args: T extends readonly unknown[] ? [...T] : [T]) => void | Promise<void>, timeout?: number) => void;
  };
  expect: {
    (value: unknown, message?: string): VectorMatchers;
    any(constructor: Function): { asymmetricMatch(value: unknown): boolean };
    objectContaining(value: Record<string, unknown>): { asymmetricMatch(value: unknown): boolean };
  };
}
