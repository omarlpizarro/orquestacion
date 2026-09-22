import { describe, expect, it } from 'vitest';
import { generateKeyBetween, nextTaskPosition } from './task-position.js';

describe('nextTaskPosition (agregar al final)', () => {
  it('genera una primera posición cuando no hay tareas previas', () => {
    expect(nextTaskPosition(null)).toBeTruthy();
  });

  it('cada posición nueva ordena después de la anterior, muchas veces seguidas', () => {
    let last: string | null = null;
    const positions: string[] = [];
    for (let i = 0; i < 50; i++) {
      last = nextTaskPosition(last);
      positions.push(last);
    }
    const sorted = [...positions].sort();
    expect(positions).toEqual(sorted);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('resuelve incrementando la parte entera (a0, a1, …, az, b00), no concatenando', () => {
    let last: string | null = null;
    const positions: string[] = [];
    for (let i = 0; i < 64; i++) {
      last = nextTaskPosition(last);
      positions.push(last);
    }
    expect(positions.slice(0, 3)).toEqual(['a0', 'a1', 'a2']);
    // az es la posición 61 (a0..az son 62 valores: a + un dígito base62).
    expect(positions[61]).toBe('az');
    expect(positions[62]).toBe('b00');
    expect(positions[63]).toBe('b01');
  });

  it('después de 1000 agregados seguidos, ninguna posición supera los 10 caracteres', () => {
    // La versión que buscaba el punto medio contra "infinito" gastaba la
    // mitad del espacio libre en cada agregado (U, k, s, w, y, z, zV, ...):
    // un carácter nuevo cada ~6 tareas, así que 600 tareas ya daban
    // posiciones de ~100 caracteres. Incrementar la parte entera en vez de
    // buscarle el punto medio al infinito crece un carácter cada ~62² a
    // ~62³ agregados, así que 1000 ni siquiera sale de largo 3.
    let last: string | null = null;
    for (let i = 0; i < 1000; i++) {
      last = nextTaskPosition(last);
      expect(last.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('generateKeyBetween (insertar entre dos)', () => {
  it('genera una clave que ordena estrictamente entre dos posiciones existentes', () => {
    const a = nextTaskPosition(null);
    const b = nextTaskPosition(a);
    const between = generateKeyBetween(a, b);
    expect(a < between).toBe(true);
    expect(between < b).toBe(true);
  });

  it('inserta correctamente entre dos posiciones consecutivas reales, muchas veces seguidas (sin quedarse sin lugar)', () => {
    // Encadenar "insertar entre las dos posiciones más cercanas que haya"
    // es el escenario que la implementación vieja no podía sostener: cada
    // inserción angosta el hueco disponible. Si `generateKeyBetween` no
    // deja lugar de verdad, esto revienta o repite un valor.
    const a = nextTaskPosition(null);
    let b = nextTaskPosition(a);
    const seen = new Set([a, b]);
    for (let i = 0; i < 20; i++) {
      const between = generateKeyBetween(a, b);
      expect(a < between && between < b).toBe(true);
      expect(seen.has(between)).toBe(false);
      seen.add(between);
      b = between; // seguimos angostando el mismo hueco
    }
  });

  it('no puede insertar entre un string y sí mismo seguido solo de ceros: no hay ningún string posible ahí, y lo dice con un error en vez de colgarse', () => {
    // "a0" y "a00" es exactamente el par que la implementación vieja
    // producía (`lastPosition + '0'`). No es que a esta implementación le
    // falte algo: no existe ningún string que ordene estrictamente entre
    // los dos, porque '0' ya es el dígito más chico del alfabeto. La
    // implementación nueva nunca genera un par así (ver test de arriba);
    // esto solo confirma que, si algo externo lo produjera, falla rápido
    // y con un mensaje claro en vez de colgarse.
    expect(() => generateKeyBetween('a0', 'a00')).toThrow();
  });

  it('sigue teniendo lugar para insertar de nuevo entre el resultado y cualquiera de sus vecinos', () => {
    const a = nextTaskPosition(null);
    const b = nextTaskPosition(a);
    const between = generateKeyBetween(a, b);
    const betweenLower = generateKeyBetween(a, between);
    const betweenUpper = generateKeyBetween(between, b);
    expect(a < betweenLower && betweenLower < between).toBe(true);
    expect(between < betweenUpper && betweenUpper < b).toBe(true);
  });

  it('permite insertar antes de la primera posición existente (sin cota inferior)', () => {
    const only = nextTaskPosition(null);
    const before = generateKeyBetween(null, only);
    expect(before < only).toBe(true);
  });

  it('rechaza un rango inválido (cota inferior no menor a la superior)', () => {
    expect(() => generateKeyBetween('b', 'a')).toThrow();
    expect(() => generateKeyBetween('a', 'a')).toThrow();
  });

  it('rechaza un string vacío como cota', () => {
    expect(() => generateKeyBetween('', null)).toThrow();
    expect(() => generateKeyBetween(null, '')).toThrow();
  });
});
