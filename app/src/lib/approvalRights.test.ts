import { describe, expect, it } from 'vitest';

import { approvalBlockReason } from './approvalRights';
import type { AppInfo } from './session';

const comp = (name: string, managerId: string | null, managerName: string | null) => ({ id: `IBGM/${name}`, name, managerId, managerName, workspace: null, repo: null, path: null, language: null, tests: null });
const app = (roles: AppInfo['roles']): AppInfo => ({
  id: 'IBGM',
  name: "Nabih's Portfolio",
  description: '',
  jiraProject: 'IBGM',
  roles,
  workspaces: [],
  components: [comp('account-service', 'u-sayeer', 'Mohd Sayeer'), comp('notification-service', 'u-karim', 'Karim')],
});

describe('who may decide a proposed change (F19 in the browser)', () => {
  it('an owner decides anything', () => {
    expect(approvalBlockReason(app(['member', 'app_owner']), 'u-nabih', ['notification-service'])).toBeNull();
    expect(approvalBlockReason(app(['member', 'app_owner']), 'u-nabih', [])).toBeNull();
  });
  it('a manager decides only their own components, and is told who can', () => {
    const m = app(['member', 'component_manager']);
    expect(approvalBlockReason(m, 'u-sayeer', ['account-service'])).toBeNull();
    expect(approvalBlockReason(m, 'u-sayeer', ['notification-service'])).toBe('Only the manager of notification-service (Karim) or an app owner can decide this change.');
    expect(approvalBlockReason(m, 'u-sayeer', ['account-service', 'notification-service'])).toMatch(/notification-service/);
    expect(approvalBlockReason(m, 'u-sayeer', [])).toMatch(/only an app owner/);
    // Not known in this session: the server decides.
    expect(approvalBlockReason(m, 'u-sayeer', null)).toBeNull();
  });
  it('a plain member cannot decide', () => {
    expect(approvalBlockReason(app(['member']), 'u-devi', ['account-service'])).toMatch(/Only an app owner/);
  });
});
