// @ts-check
/**
 * Custom ESLint rule for NASA/JPL "Power of Ten" rule 1: no recursion.
 *
 * Recursion makes stack depth depend on the input, so it can't be bounded
 * by reading the code. This rule reports a function that calls itself:
 *
 *   function walk(n) { walk(n.next) }          // reported
 *   const walk = (n) => walk(n.next)           // reported
 *   class Tree { walk() { this.walk() } }      // reported
 *
 * Limitation: indirect recursion (a calls b, b calls a) needs a whole-program
 * call graph and is not detected; code review covers that case.
 */

/** @typedef {import('eslint').Rule.Node} Node */
/** @typedef {{ name: string | null, isMember: boolean }} Frame */

/** @type {Frame} */
const ANONYMOUS = { name: null, isMember: false };

/**
 * If `parent` is a class method, class field or object property with a plain
 * (non-computed) name, returns that name; otherwise null.
 * @param {Node} parent
 * @returns {string | null}
 */
function memberName(parent) {
  const isMember =
    parent.type === 'MethodDefinition' ||
    parent.type === 'PropertyDefinition' ||
    parent.type === 'Property';
  if (!isMember || parent.computed || parent.key.type !== 'Identifier') return null;
  return parent.key.name;
}

/**
 * The name a function can be called by, and whether it's a method
 * (called as this.name()) rather than a plain function (called as name()).
 * @param {Node} node
 * @returns {Frame}
 */
function describeFunction(node) {
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) {
    return { name: node.id.name, isMember: false };
  }
  const parent = node.parent;
  // Only the Program node has no parent, and it is never a function.
  if (parent === null) return ANONYMOUS;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return { name: parent.id.name, isMember: false };
  }
  const name = memberName(parent);
  return name === null ? ANONYMOUS : { name, isMember: true };
}

/**
 * The name being called, and whether it's called through `this`.
 * @param {import('estree').CallExpression} call
 * @returns {Frame}
 */
function describeCall(call) {
  const callee = call.callee;
  if (callee.type === 'Identifier') {
    return { name: callee.name, isMember: false };
  }
  if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'ThisExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    return { name: callee.property.name, isMember: true };
  }
  return ANONYMOUS;
}

/** @type {import('eslint').Rule.RuleModule} */
const noRecursion = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow functions that call themselves (NASA/JPL Power of Ten, rule 1)',
    },
    schema: [],
    messages: {
      recursion:
        "'{{name}}' calls itself. Recursion is not allowed (Power of Ten rule 1): use a loop with a fixed upper bound instead.",
    },
  },
  create(context) {
    /** @type {Frame[]} Enclosing functions, innermost last. */
    const stack = [];
    /** @param {Node} node */
    const enter = (node) => {
      stack.push(describeFunction(node));
    };
    const exit = () => {
      stack.pop();
    };

    return {
      FunctionDeclaration: enter,
      'FunctionDeclaration:exit': exit,
      FunctionExpression: enter,
      'FunctionExpression:exit': exit,
      ArrowFunctionExpression: enter,
      'ArrowFunctionExpression:exit': exit,
      CallExpression(node) {
        const called = describeCall(node);
        if (called.name === null) return;
        const recursive = stack.some(
          (frame) => frame.name === called.name && frame.isMember === called.isMember,
        );
        if (recursive) {
          context.report({ node, messageId: 'recursion', data: { name: called.name } });
        }
      },
    };
  },
};

export default noRecursion;
