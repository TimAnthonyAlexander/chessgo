// Minimal ambient types for `bun:test`, hand-written on purpose: the project has
// no test framework dependency yet and this task adds none (no @types/bun, no
// bun-types package — see frontend task constraints). `bun test` itself needs no
// types at all (describe/test/expect are injected globals at runtime); this file
// exists only so `tsc --noEmit` (frontend's `typecheck` script) can see the shape
// of what these test files import. Loose on purpose (heavy `any`) — it's a type
// hint for the handful of APIs used here, not a full declaration of bun:test.
declare module 'bun:test' {
    export function describe(name: string, fn: () => void): void
    export function test(name: string, fn: () => void | Promise<void>): void
    export const it: typeof test
    export function beforeEach(fn: () => void | Promise<void>): void
    export function afterEach(fn: () => void | Promise<void>): void

    interface Matchers {
        toBe(expected: unknown): void
        toEqual(expected: unknown): void
        toBeNull(): void
        toBeTrue(): void
        toBeFalse(): void
        toBeTruthy(): void
        toContain(expected: unknown): void
        toThrow(expected?: unknown): void
        toHaveBeenCalledTimes(n: number): void
        not: Matchers
        resolves: Matchers
        rejects: Matchers
    }
    export function expect(actual: unknown): Matchers

    export interface Mock<T extends (...args: any[]) => any> {
        (...args: Parameters<T>): ReturnType<T>
        mock: { calls: Parameters<T>[] }
    }
    export function mock<T extends (...args: any[]) => any>(fn?: T): Mock<T>
}
