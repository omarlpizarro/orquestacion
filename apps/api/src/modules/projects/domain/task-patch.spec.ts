import { describe, expect, it } from 'vitest';
import { diffTaskPatch, type EditableTaskFields } from './task-patch.js';

const current: EditableTaskFields = {
  title: 'Excavar',
  description: 'Cimientos del frente norte',
  criticality: 'normal',
  plannedStartAt: '2026-10-20T11:00:00.000Z',
  plannedEndAt: '2026-10-21T11:00:00.000Z',
};

describe('diffTaskPatch', () => {
  it('un pedido vacío no cambia nada', () => {
    expect(diffTaskPatch(current, {})).toEqual({
      changes: {},
      changedFields: [],
      datesIncoherent: false,
    });
  });

  it('solo cambia los campos que vienen y son distintos', () => {
    const result = diffTaskPatch(current, { title: 'Excavar y nivelar', criticality: 'normal' });

    expect(result.changes).toEqual({ title: 'Excavar y nivelar' });
    expect(result.changedFields).toEqual(['title']);
  });

  it('repetir los valores actuales no cambia nada', () => {
    const result = diffTaskPatch(current, { ...current });

    expect(result.changedFields).toEqual([]);
  });

  it('las fechas se comparan como instantes: la misma hora escrita distinto es la misma', () => {
    const result = diffTaskPatch(current, { plannedStartAt: '2026-10-20T08:00:00-03:00' });

    expect(result.changedFields).toEqual([]);
  });

  it('null borra la descripción y las fechas', () => {
    const result = diffTaskPatch(current, {
      description: null,
      plannedStartAt: null,
      plannedEndAt: null,
    });

    expect(result.changes).toEqual({
      description: null,
      plannedStartAt: null,
      plannedEndAt: null,
    });
    expect(result.datesIncoherent).toBe(false);
  });

  it('borrar lo que ya está vacío no es un cambio', () => {
    const result = diffTaskPatch(
      { ...current, description: null, plannedEndAt: null },
      {
        description: null,
        plannedEndAt: null,
      },
    );

    expect(result.changedFields).toEqual([]);
  });

  it('una descripción vacía o de espacios es lo mismo que sin descripción', () => {
    expect(diffTaskPatch(current, { description: '   ' }).changes).toEqual({ description: null });
    expect(
      diffTaskPatch({ ...current, description: null }, { description: '' }).changedFields,
    ).toEqual([]);
  });

  describe('coherencia de fechas', () => {
    it('el fin antes del inicio es incoherente', () => {
      const result = diffTaskPatch(current, { plannedEndAt: '2026-10-19T11:00:00.000Z' });

      expect(result.datesIncoherent).toBe(true);
    });

    it('se evalúa contra la fecha que ya tiene la tarea cuando solo viene una', () => {
      expect(
        diffTaskPatch(current, { plannedStartAt: '2026-10-22T11:00:00.000Z' }).datesIncoherent,
      ).toBe(true);
      expect(
        diffTaskPatch(current, { plannedStartAt: '2026-10-20T12:00:00.000Z' }).datesIncoherent,
      ).toBe(false);
    });

    it('fin igual al inicio es coherente', () => {
      const result = diffTaskPatch(current, { plannedEndAt: '2026-10-20T11:00:00.000Z' });

      expect(result.datesIncoherent).toBe(false);
    });

    it('con una sola fecha no hay con qué comparar', () => {
      const result = diffTaskPatch(
        { ...current, plannedStartAt: null, plannedEndAt: null },
        { plannedEndAt: '2026-10-19T11:00:00.000Z' },
      );

      expect(result.datesIncoherent).toBe(false);
    });

    it('si las fechas no cambian no se vuelven a evaluar', () => {
      expect(diffTaskPatch(current, { title: 'Otro' }).datesIncoherent).toBe(false);
    });
  });
});
