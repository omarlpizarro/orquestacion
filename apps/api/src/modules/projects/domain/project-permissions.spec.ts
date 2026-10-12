import { describe, expect, it } from 'vitest';
import { canManageProject, decideMemberRemoval } from './project-permissions.js';

describe('canManageProject', () => {
  it('owner o director con acceso completo', () => {
    expect(
      canManageProject({ hasFullAccess: true, hasRoleCapability: true, isCreator: false }),
    ).toBe(true);
  });

  it('el creador con acceso completo, aunque su rol no tenga la capacidad', () => {
    expect(
      canManageProject({ hasFullAccess: true, hasRoleCapability: false, isCreator: true }),
    ).toBe(true);
  });

  it('un miembro cualquiera no', () => {
    expect(
      canManageProject({ hasFullAccess: true, hasRoleCapability: false, isCreator: false }),
    ).toBe(false);
  });

  it('sin acceso completo no, ni siendo el creador (se lo quitaron y solo ve su tarea asignada)', () => {
    expect(
      canManageProject({ hasFullAccess: false, hasRoleCapability: false, isCreator: true }),
    ).toBe(false);
  });
});

describe('decideMemberRemoval', () => {
  const base = {
    hasFullAccess: true,
    hasRoleCapability: false,
    isCreator: false,
    actorMemberId: 'actor',
    creatorMemberId: 'creator',
    targetMemberId: 'someone',
  };

  it('cualquier miembro puede salirse a sí mismo', () => {
    expect(decideMemberRemoval({ ...base, targetMemberId: 'actor' })).toBe('allowed');
  });

  it('quitar a otro exige poder manejar el proyecto', () => {
    expect(decideMemberRemoval(base)).toBe('forbidden');
    expect(decideMemberRemoval({ ...base, hasRoleCapability: true })).toBe('allowed');
    expect(decideMemberRemoval({ ...base, isCreator: true, actorMemberId: 'creator' })).toBe(
      'allowed',
    );
  });

  it('al creador lo quita owner o director', () => {
    expect(
      decideMemberRemoval({ ...base, targetMemberId: 'creator', hasRoleCapability: true }),
    ).toBe('allowed');
  });

  it('al creador no lo quita otro miembro, ni él mismo si no tiene la capacidad de rol', () => {
    expect(decideMemberRemoval({ ...base, targetMemberId: 'creator' })).toBe(
      'creator_removal_forbidden',
    );
    expect(
      decideMemberRemoval({
        ...base,
        targetMemberId: 'creator',
        actorMemberId: 'creator',
        isCreator: true,
      }),
    ).toBe('creator_removal_forbidden');
  });

  it('un owner que es el creador puede quitarse a sí mismo', () => {
    expect(
      decideMemberRemoval({
        ...base,
        targetMemberId: 'creator',
        actorMemberId: 'creator',
        isCreator: true,
        hasRoleCapability: true,
      }),
    ).toBe('allowed');
  });
});
