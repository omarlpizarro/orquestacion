import { populateContractRouterPaths } from '@orpc/contract';
import { healthContract } from './health/health.contract.js';

export const contract = populateContractRouterPaths({
  health: healthContract,
});
export type Contract = typeof contract;

export { type HealthOutput, healthContract, healthOutputSchema } from './health/health.contract.js';
export { base, domainErrorData, withClientMutationId } from './shared/base.contract.js';
export { idSchema, newId } from './shared/id.js';
