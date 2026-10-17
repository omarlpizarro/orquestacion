import { describe, expect, it } from 'vitest';
import { resolveTaskBlockAudience } from './task-block-audience.js';

const base = {
  explicitMemberIds: [] as string[],
  siteManagerMemberIds: [] as string[],
  projectVisibility: 'reserved',
  assigneeMemberId: null as string | null,
  reporterMemberId: 'reporter',
};

describe('resolveTaskBlockAudience', () => {
  it('avisa a los miembros explícitos', () => {
    expect(resolveTaskBlockAudience({ ...base, explicitMemberIds: ['b', 'a'] })).toEqual([
      'a',
      'b',
    ]);
  });

  it('en un proyecto reservado NO suma a los managers del sitio', () => {
    expect(
      resolveTaskBlockAudience({
        ...base,
        explicitMemberIds: ['a'],
        siteManagerMemberIds: ['gerente'],
      }),
    ).toEqual(['a']);
  });

  it('en un proyecto de sitio suma a los managers del sitio', () => {
    expect(
      resolveTaskBlockAudience({
        ...base,
        projectVisibility: 'site',
        explicitMemberIds: ['a'],
        siteManagerMemberIds: ['gerente'],
      }),
    ).toEqual(['a', 'gerente']);
  });

  it('suma al responsable de la tarea', () => {
    expect(resolveTaskBlockAudience({ ...base, assigneeMemberId: 'operario' })).toEqual([
      'operario',
    ]);
  });

  it('nunca incluye a quien reportó, aunque sea miembro, manager o responsable', () => {
    expect(
      resolveTaskBlockAudience({
        ...base,
        projectVisibility: 'site',
        explicitMemberIds: ['reporter', 'a'],
        siteManagerMemberIds: ['reporter'],
        assigneeMemberId: 'reporter',
      }),
    ).toEqual(['a']);
  });

  it('no repite a quien está por más de un camino', () => {
    expect(
      resolveTaskBlockAudience({
        ...base,
        projectVisibility: 'site',
        explicitMemberIds: ['a'],
        siteManagerMemberIds: ['a'],
        assigneeMemberId: 'a',
      }),
    ).toEqual(['a']);
  });

  it('sin nadie, lista vacía', () => {
    expect(resolveTaskBlockAudience(base)).toEqual([]);
  });
});
