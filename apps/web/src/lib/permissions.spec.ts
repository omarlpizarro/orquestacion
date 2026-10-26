import { describe, expect, it } from 'vitest';
import { canCreateProject } from './permissions';

describe('canCreateProject', () => {
  it.each(['owner', 'director'])('%s puede crear proyectos (nivel 1)', (role) => {
    expect(canCreateProject(role)).toBe(true);
  });

  it.each(['manager', 'operator', 'guest', ''])('%s no', (role) => {
    expect(canCreateProject(role)).toBe(false);
  });

  it('sin rol conocido no se ofrece', () => {
    expect(canCreateProject(null)).toBe(false);
  });

  it('con varios roles alcanza con que uno sea de nivel 1', () => {
    expect(canCreateProject('manager, director')).toBe(true);
    expect(canCreateProject('manager,operator')).toBe(false);
  });
});
