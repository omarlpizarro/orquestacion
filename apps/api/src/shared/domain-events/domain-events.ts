import { EventEmitter } from 'node:events';

/**
 * ADR-009: `EventEmitter` nativo de Node, sin agregar un paquete de
 * eventos. Cada módulo emite (`task.created`, etc.) aunque todavía no haya
 * consumidores — CLAUDE.md §5 dice que los módulos se comunican por
 * servicios exportados y eventos in-process, y este es el mecanismo
 * concreto para la segunda mitad.
 *
 * Se emite DESPUÉS de que la transacción que crea el dato haga commit
 * (nunca desde dentro del callback de `withTenant`): si se emitiera antes
 * y la transacción hiciera rollback, un consumidor reaccionaría a algo que
 * nunca pasó.
 */
export interface DomainEventMap {
  'project.created': {
    projectId: string;
    organizationId: string;
    requestId: string;
  };
  'task.created': {
    taskId: string;
    organizationId: string;
    projectId: string;
    requestId: string;
  };
  'task.updated': {
    taskId: string;
    organizationId: string;
    projectId: string;
    changedFields: string[];
    requestId: string;
  };
  'task.commented': {
    taskId: string;
    commentId: string;
    organizationId: string;
    projectId: string;
    authorMemberId: string;
    requestId: string;
  };
  'task.status_changed': {
    taskId: string;
    organizationId: string;
    fromStatus: string;
    toStatus: string;
    requestId: string;
  };
}

class DomainEvents extends EventEmitter {
  emitEvent<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): void {
    this.emit(event, payload);
  }

  onEvent<K extends keyof DomainEventMap>(
    event: K,
    listener: (payload: DomainEventMap[K]) => void,
  ): void {
    this.on(event, listener);
  }
}

export const domainEvents = new DomainEvents();
