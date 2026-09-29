import { describe, expect, it } from 'vitest';
import {
  grantSiteAccessInputSchema,
  grantSiteAccessOutputSchema,
} from './grant-site-access.contract.js';

const valid = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  site_id: '01945f4e-0000-7000-8000-000000000001',
  member_id: 'Bf4Iq6oHImMEjeHv9k89MTkB8koIY9Jf',
};

describe('grantSiteAccessInputSchema', () => {
  it('acepta un pedido válido', () => {
    expect(grantSiteAccessInputSchema.safeParse(valid).success).toBe(true);
  });

  it('exige client_mutation_id (CLAUDE.md §9)', () => {
    const { client_mutation_id: _omitted, ...withoutMutationId } = valid;
    expect(grantSiteAccessInputSchema.safeParse(withoutMutationId).success).toBe(false);
  });

  it('exige que site_id sea un UUID', () => {
    expect(grantSiteAccessInputSchema.safeParse({ ...valid, site_id: 'no-es-uuid' }).success).toBe(
      false,
    );
  });

  it('acepta un member_id opaco de Better Auth, que no es un UUID (ADR-010)', () => {
    expect(grantSiteAccessInputSchema.safeParse(valid).success).toBe(true);
  });

  it('rechaza un member_id vacío', () => {
    expect(grantSiteAccessInputSchema.safeParse({ ...valid, member_id: '' }).success).toBe(false);
  });
});

describe('grantSiteAccessOutputSchema', () => {
  it('devuelve el sitio y el miembro, sin datos de más', () => {
    const parsed = grantSiteAccessOutputSchema.parse({
      site_id: valid.site_id,
      member_id: valid.member_id,
      extra: 'no debería pasar',
    });
    expect(parsed).toEqual({ site_id: valid.site_id, member_id: valid.member_id });
  });
});
