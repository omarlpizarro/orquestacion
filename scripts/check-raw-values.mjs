#!/usr/bin/env node
// Falla si un componente de la web o del móvil lleva un color o un tamaño escrito a mano.
//
//   node scripts/check-raw-values.mjs            (forma parte de `pnpm check`)
//
// docs/design-guidelines.md, sección 11.1: "Un componente nunca contiene un hexadecimal, un tamaño
// de fuente o un espaciado escrito a mano: los toma del tema. Un hexadecimal suelto en un
// componente es un defecto de revisión." Esto lo convierte en un chequeo automático. Los valores
// viven en `packages/ui-tokens`, que no se escanea.
//
// Qué marca:
//   - colores hexadecimales (#RGB, #RGBA, #RRGGBB, #RRGGBBAA), también dentro de una clase de
//     Tailwind como `text-[#1F4FD1]`;
//   - funciones de color (`rgb(`, `rgba(`, `hsl(`, `hsla(`, `hwb(`, `lab(`, `lch(`, `oklab(`, `oklch(`);
//   - valores arbitrarios de Tailwind con unidad fija (`p-[13px]`, `text-[0.8rem]`), que se saltean la
//     escala de espaciado y los roles de tipografía.
//
// Qué NO escanea: comentarios, archivos `*.spec.*` y `*.test.*`, ni `node_modules`, `dist`, `.next`.
//
// Salida de emergencia, siempre con el motivo y a la vista de quien revisa:
//   // raw-values-ok: <por qué este valor no puede ser un token>
// en la misma línea o en la línea de arriba. Sin motivo no vale.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css']);
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.expo',
  'build',
  'coverage',
  '.turbo',
]);
const SKIPPED_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;

// El `#` no puede venir pegado a una palabra, a `&` (entidad HTML: `&#123;`), a `/` ni a `-`; y lo que
// sigue no puede seguir siendo parte de una palabra (`#abcdefg` no es un color).
const HEX_COLOR = /(?<![\w&#/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const ARBITRARY_SIZE = /\[-?\d*\.?\d+(?:px|rem|em)\]/g;
const OK_MARKER = /raw-values-ok:\s*\S+/;

const RULES = [
  {
    pattern: HEX_COLOR,
    what: 'color hexadecimal',
    hint: 'usá un color del tema (variable CSS o clase de @orq/ui-tokens)',
  },
  {
    pattern: COLOR_FUNCTION,
    what: 'función de color',
    hint: 'usá un color del tema (variable CSS o clase de @orq/ui-tokens)',
  },
  {
    pattern: ARBITRARY_SIZE,
    what: 'tamaño arbitrario',
    hint: 'usá la escala de espaciado o un rol de tipografía de @orq/ui-tokens',
  },
];

/** Reemplaza los comentarios por espacios, conservando los saltos de línea (los números de línea valen). */
function blankComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, before) => before + blank(match.slice(before.length)));
}

/**
 * Los valores escritos a mano de un archivo.
 * @param {string} source
 * @returns {Array<{ line: number, column: number, what: string, value: string, hint: string }>}
 */
export function findRawValues(source) {
  const originalLines = source.split('\n');
  const scanned = blankComments(source).split('\n');
  const findings = [];

  scanned.forEach((text, index) => {
    const allowed =
      OK_MARKER.test(originalLines[index] ?? '') || OK_MARKER.test(originalLines[index - 1] ?? '');
    if (allowed) return;
    for (const { pattern, what, hint } of RULES) {
      for (const match of text.matchAll(pattern)) {
        findings.push({
          line: index + 1,
          column: (match.index ?? 0) + 1,
          what,
          value: match[0],
          hint,
        });
      }
    }
  });
  return findings;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (EXTENSIONS.has(extname(name)) && !SKIPPED_FILE.test(name)) yield path;
  }
}

/**
 * Escanea las carpetas dadas (las que no existen se saltean: `apps/mobile` todavía no está).
 * @param {string[]} directories
 */
export function scanDirectories(directories) {
  const results = [];
  for (const directory of directories) {
    let isDirectory = false;
    try {
      isDirectory = statSync(directory).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;
    for (const file of walk(directory)) {
      for (const finding of findRawValues(readFileSync(file, 'utf8'))) {
        results.push({ file, ...finding });
      }
    }
  }
  return results;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const results = scanDirectories([join(root, 'apps', 'web', 'src'), join(root, 'apps', 'mobile')]);
  if (results.length === 0) return;

  console.error(
    'Hay colores o tamaños escritos a mano en componentes (docs/design-guidelines.md, §11.1):\n',
  );
  for (const { file, line, column, what, value, hint } of results) {
    const shown = relative(root, file).split(sep).join('/');
    console.error(`  ${shown}:${line}:${column}  ${what} ${value}\n      → ${hint}`);
  }
  console.error(
    '\nSi de verdad no puede ser un token, dejalo con el motivo a la vista: // raw-values-ok: <motivo>',
  );
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
