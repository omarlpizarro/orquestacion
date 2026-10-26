import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import { DirectoryForbiddenError } from '../../domain/errors/directory-forbidden.error.js';
import type { TenancyService } from '../../tenancy.service.js';
import { GetMemberNamesHandler } from './get-member-names.handler.js';

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'operator' };

function build() {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const tenancy = { listMemberNames: vi.fn().mockResolvedValue([{ id: 'a', name: 'Ana' }]) };
  return {
    handler: new GetMemberNamesHandler(
      { withTenant } as unknown as TransactionService,
      tenancy as unknown as TenancyService,
    ),
    tenancy,
  };
}

const run = (handler: GetMemberNamesHandler, ids: string | string[], role = tenant.role) =>
  runWithRequestContext({ requestId: 'req-1', tenant: { ...tenant, role } }, () =>
    handler.execute({ ids }),
  );

describe('GetMemberNamesHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resuelve los nombres con la organización de quien pregunta', async () => {
    const { handler, tenancy } = build();

    const output = await run(handler, ['a', 'b']);

    expect(output).toEqual({ members: [{ id: 'a', name: 'Ana' }] });
    expect(tenancy.listMemberNames).toHaveBeenCalledWith(
      {},
      { organizationId: tenant.organizationId, memberIds: ['a', 'b'] },
    );
  });

  it('un único id suelto se trata como una lista de uno', async () => {
    const { handler, tenancy } = build();

    await run(handler, 'solo');

    expect(tenancy.listMemberNames).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ memberIds: ['solo'] }),
    );
  });

  it.each(['owner', 'director', 'manager', 'operator'])('el rol %s puede', async (role) => {
    const { handler } = build();
    await expect(run(handler, ['a'], role)).resolves.toEqual({
      members: [{ id: 'a', name: 'Ana' }],
    });
  });

  it('un rol sin la capacidad no consulta nada', async () => {
    const { handler, tenancy } = build();

    await expect(run(handler, ['a'], 'rol_inventado')).rejects.toBeInstanceOf(
      DirectoryForbiddenError,
    );
    expect(tenancy.listMemberNames).not.toHaveBeenCalled();
  });

  it('lanza si no hay organización activa en el contexto', async () => {
    const { handler } = build();

    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => handler.execute({ ids: ['a'] })),
    ).rejects.toThrow(/sesión con organización activa/);
  });
});
