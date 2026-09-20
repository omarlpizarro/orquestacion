import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DomainError } from './domain-error.js';

/**
 * Traduce DomainError a HTTP para rutas de Nest planas (webhooks, endpoints
 * que no pasan por oRPC). Las rutas de oRPC tienen su propio pipeline de
 * errores vía el contrato (`.errors()`); este filtro no las alcanza ni hace
 * falta que lo haga.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    reply.status(exception.httpStatus).send({
      code: exception.code,
      message: exception.message,
      data: exception.data,
    });
  }
}
