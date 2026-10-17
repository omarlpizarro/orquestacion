#!/usr/bin/env node
// Falla si algún `scripts/*.sh` no está como 100755 en git.
//
//   node scripts/check-script-modes.mjs      (forma parte de `pnpm check`)
//
// Por qué mira el índice de git y no el sistema de archivos: en Windows (donde se desarrolla)
// todo archivo figura como ejecutable o ninguno, según el momento, y lo que cuenta es el modo que
// git registra, que es el que llega al servidor de Linux. Un `.sh` que se commitea como 100644
// anda con `bash scripts/x.sh` y falla con `scripts/x.sh` (que es como lo documentan el README y
// `deploy.sh`), y nadie se entera hasta ese día.
//
// Se arregla con: git update-index --chmod=+x scripts/<archivo>.sh
import { execFileSync } from 'node:child_process';

const EXECUTABLE = '100755';

// `-s` imprime "<modo> <objeto> <etapa>\t<ruta>" del índice; el pathspec `:(glob)` limita a
// `scripts/*.sh` sin entrar en subcarpetas.
const output = execFileSync('git', ['ls-files', '-s', '--', ':(glob)scripts/*.sh'], {
  encoding: 'utf8',
});

const offenders = output
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t');
    return { mode: meta?.split(' ')[0], path };
  })
  .filter(({ mode }) => mode !== EXECUTABLE);

if (offenders.length > 0) {
  console.error('Estos scripts de shell no están como 100755 en git:\n');
  for (const { mode, path } of offenders) console.error(`  ${mode}  ${path}`);
  console.error(
    `\nCorregí cada uno con:\n  git update-index --chmod=+x ${offenders.map((o) => o.path).join(' ')}`,
  );
  process.exit(1);
}
