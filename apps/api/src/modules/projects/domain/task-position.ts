const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGIT_COUNT = DIGITS.length;
const INTEGER_ZERO = 'a0';

/**
 * Cota de seguridad para la parte fraccionaria: en uso normal esto nunca se
 * acerca a este número de dígitos compartidos. Si se llega acá es porque
 * `lower` y `upper` no dejan lugar para insertar entre ellos.
 */
const MAX_SHARED_FRACTION_DIGITS = 128;

function digitValue(char: string): number {
  return DIGITS.indexOf(char);
}

/**
 * Cuántos caracteres mide la "parte entera" de una posición, a partir de su
 * primer carácter. Es lo que permite que el largo de esa parte varíe (para
 * poder representar magnitudes cada vez más grandes sin límite) sin romper
 * el orden por comparación de texto: una minúscula más lejos de 'a' es una
 * parte entera más larga y más grande en magnitud (a0 < b00 < c000 < ...);
 * una mayúscula más lejos de 'Z' es más larga y más chica (más "negativa":
 * ... < X0000 < Y000 < Z0 < a0). El cruce de cero es Z0 → a0.
 */
function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`Cabecera de posición inválida: "${head}".`);
}

function getIntegerPart(key: string): string {
  const length = getIntegerLength(key.charAt(0));
  if (length > key.length) {
    throw new Error(`Posición inválida: "${key}".`);
  }
  return key.slice(0, length);
}

/**
 * Incrementa la parte entera en uno, en base 62 sobre sus dígitos después
 * de la cabecera, con acarreo. `null` si ya está en el máximo representable
 * (en la práctica, inalcanzable). El salto de largo (a0..az → b00, o Y00 →
 * Z0) es lo que mantiene "más grande en magnitud" == "ordena después" pese
 * a que las partes enteras no tienen todas el mismo largo.
 */
function incrementInteger(value: string): string | null {
  const head = value.charAt(0);
  const digits = value.slice(1).split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const next = digitValue(digits[i] as string) + 1;
    if (next === DIGIT_COUNT) {
      digits[i] = DIGITS[0] as string;
    } else {
      digits[i] = DIGITS[next] as string;
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return `a${DIGITS[0]}`;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(DIGITS[0] as string);
  else digits.pop();
  return nextHead + digits.join('');
}

/** Espejo de `incrementInteger`. `null` si ya está en el mínimo representable. */
function decrementInteger(value: string): string | null {
  const head = value.charAt(0);
  const digits = value.slice(1).split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const next = digitValue(digits[i] as string) - 1;
    if (next === -1) {
      digits[i] = DIGITS[DIGIT_COUNT - 1] as string;
    } else {
      digits[i] = DIGITS[next] as string;
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return `Z${DIGITS[DIGIT_COUNT - 1]}`;
  if (head === 'A') return null;
  const prevHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prevHead < 'Z') digits.push(DIGITS[DIGIT_COUNT - 1] as string);
  else digits.pop();
  return prevHead + digits.join('');
}

/**
 * Punto medio entre dos partes fraccionarias (secuencias de dígitos planas,
 * sin la cabecera de largo variable de la parte entera). `null` en
 * cualquiera de los dos lados es "sin cota". A diferencia de la parte
 * entera, achicar/agrandar acá SÍ consume espacio disponible — por eso
 * `generateKeyBetween` solo cae en esto cuando de verdad hace falta
 * insertar entre dos posiciones existentes, nunca para agregar al final.
 */
function fractionBetween(lower: string | null, upper: string | null): string {
  let result = '';
  let depth = 0;

  for (;;) {
    if (depth > MAX_SHARED_FRACTION_DIGITS) {
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

/**
 * Indexación fraccionaria real (docs/data-model.md, convención "Orden
 * manual"): genera una clave que ordena, en comparación de texto estándar
 * (Postgres incluido), estrictamente entre `lower` y `upper`. Cualquiera de
 * los dos puede ser `null` — sin cota inferior o sin cota superior.
 *
 * Cada clave tiene una parte entera (largo variable, ver
 * `getIntegerLength`) y, opcionalmente, una parte fraccionaria después.
 * Agregar al final (`upper` null) resuelve incrementando la parte entera
 * de `lower` — a0, a1, …, az, b00, … — sin tocar ninguna fracción, así que
 * el largo crece de a un carácter cada ~62 agregados, no cada uno. Solo
 * insertar entre dos posiciones que ya comparten parte entera (o donde no
 * queda una parte entera libre en el medio) cae en la parte fraccionaria,
 * que sí puede angostarse con cada inserción — es inherente a compartir el
 * mismo hueco, no un defecto de esta implementación.
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

  if (lower === null && upper === null) return INTEGER_ZERO;

  if (lower === null) {
    const upperInteger = getIntegerPart(upper as string);
    const upperFraction = (upper as string).slice(upperInteger.length);
    if (upperInteger < (upper as string)) {
      // La parte entera sola (sin nada de la fracción de `upper`) ya es
      // menor a `upper` completo, por ser un prefijo propio.
      return upperInteger;
    }
    const decremented = decrementInteger(upperInteger);
    if (decremented !== null) return decremented;
    return upperInteger + fractionBetween('', upperFraction);
  }

  if (upper === null) {
    const lowerInteger = getIntegerPart(lower);
    const incremented = incrementInteger(lowerInteger);
    if (incremented !== null) return incremented;
    // No se puede incrementar más la parte entera (caso extremo,
    // prácticamente inalcanzable): queda buscar lugar en la fracción.
    const lowerFraction = lower.slice(lowerInteger.length);
    return lowerInteger + fractionBetween(lowerFraction, null);
  }

  const lowerInteger = getIntegerPart(lower);
  const upperInteger = getIntegerPart(upper);

  if (lowerInteger === upperInteger) {
    const lowerFraction = lower.slice(lowerInteger.length);
    const upperFraction = upper.slice(upperInteger.length);
    return lowerInteger + fractionBetween(lowerFraction, upperFraction);
  }

  const incremented = incrementInteger(lowerInteger);
  if (incremented !== null && incremented < upper) {
    return incremented;
  }
  const lowerFraction = lower.slice(lowerInteger.length);
  return lowerInteger + fractionBetween(lowerFraction, null);
}

/** Agregar al final: sin cota superior. */
export function nextTaskPosition(lastPosition: string | null): string {
  return generateKeyBetween(lastPosition, null);
}
