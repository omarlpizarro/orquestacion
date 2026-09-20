import { Global, Module } from '@nestjs/common';
import { loadServerEnv, type ServerEnv } from '@orq/config';

export const SERVER_ENV = Symbol('SERVER_ENV');

@Global()
@Module({
  // useFactory, no useValue: `loadServerEnv()` debe correr recién cuando
  // Nest arma el contenedor, no al importar este archivo. Con useValue,
  // cualquier import de este módulo —incluso solo por el tipo `ServerEnv`—
  // dispara el parseo de variables de entorno como efecto de lado, y rompe
  // tests unitarios que nunca deberían necesitar un .env real.
  providers: [{ provide: SERVER_ENV, useFactory: () => loadServerEnv() }],
  exports: [SERVER_ENV],
})
export class ConfigModule {}

export type { ServerEnv };
