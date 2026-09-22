/**
 * ADR-006: el esquema mantiene `path` como `ltree` de profundidad libre,
 * pero el dominio limita a tres niveles con una constante, no con un
 * `CHECK` de base. `parentDepth` es `nlevel(parent.path)`: la raíz tiene
 * profundidad 1, así que una subtarea de una subtarea de una subtarea (4
 * niveles) queda del otro lado del límite.
 */
export const MAX_TASK_DEPTH = 3;

export function exceedsMaxTaskDepth(parentDepth: number): boolean {
  return parentDepth + 1 > MAX_TASK_DEPTH;
}
