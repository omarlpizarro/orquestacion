/**
 * Indexación fraccionaria mínima (docs/data-model.md, convención "Orden
 * manual"): agregar al final de la lista es el único caso que este slice
 * necesita — insertar entre dos tareas existentes es de un slice futuro de
 * reordenamiento. Cualquier string que empiece con `lastPosition` como
 * prefijo ordena después de él en comparación de texto estándar (Postgres
 * incluido), así que alcanza con extenderlo.
 */
export function nextTaskPosition(lastPosition: string | null): string {
  if (lastPosition === null) return 'a0';
  return `${lastPosition}0`;
}
