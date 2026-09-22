const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGIT_COUNT = DIGITS.length;

/**
 * Cota de seguridad: en uso normal esto nunca se acerca a este número de
 * dígitos compartidos. Si se llega acá es porque `lower` y `upper` no
 * dejan lugar para insertar entre ellos (por ejemplo, `upper` es `lower`
 * seguido solo de ceros, como "a0" y "a00" — ningún algoritmo de
 * indexación fraccionaria puede insertar ahí, la solución es que quien
 * genera las posiciones nunca produzca ese par, no forzar un resultado).
 */
const MAX_SHARED_DIGITS = 128;

function digitValue(char: string): number {
  return DIGITS.indexOf(char);
}

/**
 * Indexación fraccionaria real (docs/data-model.md, convención "Orden
 * manual"): genera una clave que ordena, en comparación de texto estándar
 * (Postgres incluido), estrictamente entre `lower` y `upper`. Cualquiera de
 * los dos puede ser `null` — sin cota inferior o sin cota superior.
 *
 * La versión anterior (`lastPosition + '0'`) solo cubría "agregar al
 * final" y, además, rompía ese mismo caso apenas alguien necesitara
 * insertar después: entre "a0" y "a00" no hay ningún string posible,
 * porque "0" ya es el dígito más chico del alfabeto — no queda lugar
 * debajo. Acá cada llamada busca el punto medio real entre las dos cotas,
 * dígito a dígito, así que siempre hay lugar para insertar de nuevo entre
 * el resultado y cualquiera de sus vecinos.
 */
export function generateKeyBetween(lower: string | null, upper: string | null): string {
  if (lower === '' || upper === '') {
    throw new Error('La posición no puede ser un string vacío.');
  }
  if (lower !== null && upper !== null && lower >= upper) {
    throw new Error(
      `No se puede generar una posición entre "${lower}" y "${upper}": el límite inferior no es menor al superior.`,
    );
  }

  let result = '';
  let depth = 0;

  for (;;) {
    if (depth > MAX_SHARED_DIGITS) {
      throw new Error(
        `No hay lugar para insertar entre "${lower}" y "${upper}": no dejan lugar para una posición intermedia.`,
      );
    }
    const lowerIsReal = lower !== null && depth < lower.length;
    const upperIsReal = upper !== null && depth < upper.length;
    const loDigit = lower === null ? -1 : lowerIsReal ? digitValue(lower.charAt(depth)) : 0;
    const hiDigit =
      upper === null ? DIGIT_COUNT : upperIsReal ? digitValue(upper.charAt(depth)) : 0;

    if (hiDigit - loDigit >= 2) {
      const mid = loDigit + Math.floor((hiDigit - loDigit) / 2);
      return result + DIGITS[mid];
    }

    if (loDigit === hiDigit) {
      // Prefijo común real: mismo dígito de los dos lados, hay que seguir
      // comparando un dígito más profundo en ambos.
      result += DIGITS[loDigit];
      depth += 1;
      continue;
    }

    if (loDigit >= 0) {
      // hiDigit === loDigit + 1: no hay dígito estrictamente entre los dos
      // en esta posición. Tomamos el de `lower` — cualquier continuación
      // mayor a la de `lower` sigue siendo menor que `upper`, así que
      // `upper` deja de limitarnos de acá en adelante.
      result += DIGITS[loDigit];
      upper = null;
      depth += 1;
      continue;
    }

    // Sin cota inferior y el dígito de `upper` acá es 0 (el mínimo): si es
    // el último dígito real de `upper`, lo que ya acumulamos es un
    // prefijo propio de `upper` — y por lo tanto ya menor a él — así que
    // cortamos acá en vez de seguir agregando ceros para siempre.
    if (!upperIsReal || depth === (upper as string).length - 1) {
      return result;
    }
    result += DIGITS[0];
    depth += 1;
  }
}

/** Agregar al final: sin cota superior. */
export function nextTaskPosition(lastPosition: string | null): string {
  return generateKeyBetween(lastPosition, null);
}
