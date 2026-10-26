import { Injectable } from '@nestjs/common';
import type { GetMemberNamesOutput } from '@orq/contracts';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { DirectoryForbiddenError } from '../../domain/errors/directory-forbidden.error.js';
import { TenancyService } from '../../tenancy.service.js';
import type { GetMemberNamesQuery } from './get-member-names.query.js';

@Injectable()
export class GetMemberNamesHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
  ) {}

  async execute(query: GetMemberNamesQuery): Promise<GetMemberNamesOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('get-member-names requiere una sesión con organización activa.');
    }
    if (!hasCapability(tenant.role, { directory: ['read'] })) {
      throw new DirectoryForbiddenError();
    }

    // El contrato ya normalizó `ids` a un arreglo de 1 a 100 elementos. El servicio quita los
    // repetidos y conserva el orden del pedido.
    const ids = Array.isArray(query.ids) ? query.ids : [query.ids];
    const members = await this.transactions.withTenant((tx) =>
      this.tenancy.listMemberNames(tx, { organizationId: tenant.organizationId, memberIds: ids }),
    );
    return { members };
  }
}
