import { can, type EffectiveRole, type Permission, PERMISSIONS } from './permissions';

/**
 * The permission matrix from docs/requirements.md §2, written out in full. If a role's
 * permissions change, this table and the requirements doc must change in the same PR.
 */
const MATRIX: Record<Permission, [pm: boolean, dev: boolean, viewer: boolean]> = {
  'project:read': [true, true, true],
  'project:update': [true, false, false],
  'project:archive': [true, false, false],
  'member:manage': [true, false, false],
  'issue:create': [true, true, false],
  'issue:update': [true, true, false],
  'issue:delete': [true, false, false],
  'comment:create': [true, true, false],
  'comment:moderate': [true, false, false],
  'attachment:create': [true, true, false],
  'sprint:manage': [true, false, false],
  'github:link': [true, false, false],
  'github:sync': [true, true, false],
  'ai:write': [true, true, false],
  'ai:read': [true, true, true],
  'document:write': [true, true, false],
};

const ROLES: EffectiveRole[] = ['PROJECT_MANAGER', 'DEVELOPER', 'VIEWER'];

describe('permission matrix', () => {
  it('covers every permission', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
  });

  describe.each(PERMISSIONS)('%s', (permission) => {
    it.each(ROLES.map((role, i) => [role, MATRIX[permission][i]] as const))(
      '%s → %s',
      (role, expected) => {
        expect(can(role, permission)).toBe(expected);
      },
    );

    it('ADMIN → true', () => {
      expect(can('ADMIN', permission)).toBe(true);
    });
  });
});
