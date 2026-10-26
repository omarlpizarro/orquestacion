import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCssVariables } from './css.js';
import { toTailwindTheme } from './tailwind.js';

// Corre desde `dist/` (`node dist/build-css.js`, el segundo paso de `build`): escribe `dist/tokens.css`,
// que el paquete exporta como `@orq/ui-tokens/tokens.css` (variables CSS planas), y `dist/tailwind.css`
// (`@orq/ui-tokens/tailwind.css`, el tema de Tailwind que importa la web).
const outDir = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tokens.css'), toCssVariables());
writeFileSync(join(outDir, 'tailwind.css'), toTailwindTheme());
