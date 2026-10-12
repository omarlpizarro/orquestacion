/**
 * Topes de las lecturas de tareas. Una lectura que devuelve un árbol no se pagina
 * por cursor (un corte a la mitad deja hijas sin padre): se acota y avisa con un
 * indicador `truncated`. En la fase 2 una organización tiene cientos de tareas por
 * proyecto; si algún día no alcanza, se agrega paginación de verdad.
 */
export const MAX_PROJECT_TASKS = 1000;
export const MAX_SUBTASKS = 500;
export const MAX_TASK_UPDATES = 200;
