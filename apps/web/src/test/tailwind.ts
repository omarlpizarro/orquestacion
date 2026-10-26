import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Compila el CSS REAL de la web (`src/app/globals.css`: Tailwind + el tema de `@orq/ui-tokens`) con las
 * clases que se le indiquen, igual que lo haría el build de Next. Sirve para los tests que comprueban que
 * el vocabulario de clases es cerrado: con un tema anulado, una clase mal escrita (`p-7`, `bg-surfce`) no
 * falla, simplemente no genera nada, y a ojo no se nota.
 *
 * `postcss` no es dependencia de `apps/web` (lo trae `@tailwindcss/postcss`): se resuelve desde el plugin.
 */
const require = createRequire(import.meta.url);
const globalsPath = fileURLToPath(new URL('../app/globals.css', import.meta.url));

type PostCss = (plugins: unknown[]) => {
  process: (css: string, options: { from: string }) => Promise<{ css: string }>;
};

const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss') as PostCss;
const tailwind = require('@tailwindcss/postcss') as () => unknown;

/** Una clase tal como aparece en un selector de CSS: `enabled:hover:bg-x` → `.enabled\:hover\:bg-x`. */
export function selectorFor(className: string): string {
  return `.${className.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)}`;
}

export async function compileWithClasses(classes: readonly string[]): Promise<string> {
  const unique = [...new Set(classes)];
  const input = `${readFileSync(globalsPath, 'utf8')}\n@source inline("${unique.join(' ')}");\n`;
  const result = await postcss([tailwind()]).process(input, { from: globalsPath });
  return result.css;
}

/** Las clases de todos los atributos `class="..."` de un HTML. */
export function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    (match[1] ?? '').split(/\s+/).filter(Boolean),
  );
}

/** Las clases de `classes` que el CSS compilado NO define (las que no hacen nada). */
export async function undefinedClasses(classes: readonly string[]): Promise<string[]> {
  const css = await compileWithClasses(classes);
  return [...new Set(classes)].filter((name) => !css.includes(selectorFor(name)));
}
