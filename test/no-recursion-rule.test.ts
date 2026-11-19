import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import noRecursion from '../eslint-rules/no-recursion.js';

// Let ESLint's RuleTester report through Vitest.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });

tester.run('no-recursion (Power of Ten rule 1)', noRecursion, {
  valid: [
    'function a() { return b(); } function b() { return 1; }',
    'const sum = (xs) => xs.reduce((t, x) => t + x, 0);',
    'class A { run() { return this.other(); } other() { return 1; } }',
    // Calling a same-named function on another object is not recursion.
    'class Repo { find(id) { return this.db.find(id); } }',
    // A method calling a free function with its own name is not recursion either.
    'class A { log() { log(); } }',
    'const o = { [name]() { return name(); } };',
  ],
  invalid: [
    {
      code: 'function walk(n) { if (n) walk(n.next); }',
      errors: [{ messageId: 'recursion', data: { name: 'walk' } }],
    },
    {
      code: 'const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));',
      errors: [{ messageId: 'recursion' }],
    },
    {
      code: 'const f = function g() { return g(); };',
      errors: [{ messageId: 'recursion', data: { name: 'g' } }],
    },
    {
      code: 'class Tree { walk() { return this.walk(); } }',
      errors: [{ messageId: 'recursion', data: { name: 'walk' } }],
    },
    {
      code: 'const o = { walk() { return this.walk(); } };',
      errors: [{ messageId: 'recursion' }],
    },
    {
      // Recursion through an inner closure is still recursion.
      code: 'function outer() { const inner = () => outer(); return inner; }',
      errors: [{ messageId: 'recursion', data: { name: 'outer' } }],
    },
  ],
});
