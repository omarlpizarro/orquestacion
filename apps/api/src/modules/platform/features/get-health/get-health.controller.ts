import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { DatabaseMisconfiguredError } from './database-misconfigured.error.js';
import { GetHealthHandler } from './get-health.handler.js';

@Controller()
export class GetHealthController {
  constructor(private readonly handler: GetHealthHandler) {}

  @Implement(contract.health.get)
  get() {
    return implement(contract.health.get).handler(async ({ errors }) => {
      try {
        return await this.handler.execute();
      } catch (error) {
        if (error instanceof DatabaseMisconfiguredError) {
          throw errors.DATABASE_MISCONFIGURED({ message: error.message });
        }
        throw error;
      }
    });
  }
}
