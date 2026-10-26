/**
 * Estados de tarea de docs/design-guidelines.md, sección 3. Colores fijos, iguales en todo el
 * producto e INDEPENDIENTES de la marca: si cambia la paleta, los estados no cambian.
 *
 * Las claves son los valores de `task.status` de la API, para que un componente use el estado
 * que le llega sin traducirlo. Un estado se muestra siempre con ícono Y texto, nunca solo con color.
 */
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface StatusColors {
  text: string;
  bg: string;
}

/** Nombres del conjunto Lucide (sección 7.7). El paquete no depende de Lucide: solo los nombra. */
export type StatusIconName = 'circle' | 'play' | 'circle-slash' | 'eye' | 'check' | 'x';

export const taskStatusIcons: Record<TaskStatus, StatusIconName> = {
  pending: 'circle',
  in_progress: 'play',
  blocked: 'circle-slash',
  in_review: 'eye',
  done: 'check',
  cancelled: 'x',
};

export const taskStatusLabels: Record<TaskStatus, string> = {
  pending: 'Pendiente',
  in_progress: 'En curso',
  blocked: 'Bloqueada',
  in_review: 'En revisión',
  done: 'Terminada',
  cancelled: 'Cancelada',
};

export const lightStatusColors: Record<TaskStatus, StatusColors> = {
  pending: { text: '#4B5563', bg: '#EEF0F3' },
  in_progress: { text: '#1D4ED8', bg: '#E3EBFD' },
  blocked: { text: '#C4320A', bg: '#FDE7E5' },
  in_review: { text: '#6E3BC2', bg: '#EFE8FB' },
  done: { text: '#067647', bg: '#E3F4EA' },
  cancelled: { text: '#5F6673', bg: '#F1F2F4' },
};

export const darkStatusColors: Record<TaskStatus, StatusColors> = {
  pending: { text: '#C3C9D2', bg: '#2A2F38' },
  in_progress: { text: '#8DB0FF', bg: '#172A4D' },
  blocked: { text: '#FF9C7A', bg: '#3D1A12' },
  in_review: { text: '#C4A6FF', bg: '#2A1E45' },
  done: { text: '#6FD49B', bg: '#12301F' },
  cancelled: { text: '#9AA1AC', bg: '#23262C' },
};

/**
 * "Vencida" no es un estado: es una condición de una tarea pendiente, en curso o bloqueada. Se
 * marca con el color de Bloqueada en el texto de la hora, con ícono de reloj y la palabra
 * "Venció" o "Vencida" (sección 3).
 */
export const overdue = {
  /** Se usa el color de texto de `blocked` para la hora. */
  colorFrom: 'blocked' as const satisfies TaskStatus,
  icon: 'clock' as const,
  labels: ['Venció', 'Vencida'] as const,
};
