import { ProjectKey } from '@forge/types';

import { suggestProjectKey } from './project-key';

describe('suggestProjectKey', () => {
  it.each([
    ['Payments Platform', 'PP'],
    ['Identity & Access', 'IA'],
    ['Checkout', 'CHECK'],
    ['  mobile app v2 ', 'MAV'],
    ['Café Ops', 'CO'],
    ['2026 Roadmap', 'ROADM'],
    ['A', ''],
    ['', ''],
  ])('%j → %j', (name, expected) => {
    expect(suggestProjectKey(name)).toBe(expected);
  });

  it('only ever suggests keys the API accepts', () => {
    for (const name of ['Payments Platform', 'Checkout', 'x y z', 'Data & ML', 'API Gateway 2']) {
      const key = suggestProjectKey(name);
      if (key) expect(ProjectKey.safeParse(key).success).toBe(true);
    }
  });
});
