import { describe, expect, it } from 'vitest';
import { invariant, InvariantError } from '../src/lib/invariant.js';

// Values the type checker can't predict, like real data.
const isPositive = (n: number) => n > 0;
const firstOrNull = (items: string[]): string | null => items[0] ?? null;

describe('invariant()', () => {
  it('does nothing when the condition holds', () => {
    expect(() => {
      invariant(isPositive(1), 'never shown');
    }).not.toThrow();
  });

  it('throws an InvariantError with the message when it does not', () => {
    expect(() => {
      invariant(isPositive(-1), 'the number must be positive');
    }).toThrow(new InvariantError('Invariant violated: the number must be positive'));
  });

  it('narrows types for the code after it', () => {
    const value = firstOrNull(['x']);
    invariant(value !== null, 'there is a first item');
    // Compiles only because invariant() told TypeScript that value is a string.
    expect(value.toUpperCase()).toBe('X');
  });
});
