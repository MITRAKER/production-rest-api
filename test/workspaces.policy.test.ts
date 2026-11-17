import { describe, expect, it } from 'vitest';
import { can, outranks, type Action } from '../src/modules/workspaces/workspaces.policy.js';

/**
 * Unit tests for the permission table. No database, no HTTP: just the rules.
 * The table below IS the spec; if you change a rule, this is the test to update.
 */
const expected: Record<Action, { OWNER: boolean; ADMIN: boolean; MEMBER: boolean }> = {
  'workspace:read': { OWNER: true, ADMIN: true, MEMBER: true },
  'workspace:update': { OWNER: true, ADMIN: true, MEMBER: false },
  'workspace:delete': { OWNER: true, ADMIN: false, MEMBER: false },
  'members:read': { OWNER: true, ADMIN: true, MEMBER: true },
  'members:remove': { OWNER: true, ADMIN: true, MEMBER: false },
  'members:changeRole': { OWNER: true, ADMIN: false, MEMBER: false },
  'invitations:manage': { OWNER: true, ADMIN: true, MEMBER: false },
};

describe('can(role, action)', () => {
  for (const [action, byRole] of Object.entries(expected)) {
    for (const [role, allowed] of Object.entries(byRole)) {
      it(`${role} ${allowed ? 'can' : 'cannot'} ${action}`, () => {
        expect(can(role as 'OWNER' | 'ADMIN' | 'MEMBER', action as Action)).toBe(allowed);
      });
    }
  }
});

describe('outranks(actor, target)', () => {
  it('only a strictly higher role outranks', () => {
    expect(outranks('OWNER', 'ADMIN')).toBe(true);
    expect(outranks('OWNER', 'MEMBER')).toBe(true);
    expect(outranks('ADMIN', 'MEMBER')).toBe(true);

    expect(outranks('OWNER', 'OWNER')).toBe(false);
    expect(outranks('ADMIN', 'ADMIN')).toBe(false);
    expect(outranks('ADMIN', 'OWNER')).toBe(false);
    expect(outranks('MEMBER', 'MEMBER')).toBe(false);
    expect(outranks('MEMBER', 'ADMIN')).toBe(false);
  });
});
