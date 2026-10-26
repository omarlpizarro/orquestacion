// Tests de infra/docker/server.env.example. Corren con el ejecutor nativo de Node:
//   node --test "scripts/*.test.mjs"
//
// `scripts/deploy.sh` se niega a correr si el `.env` del servidor contiene la cadena CHANGE_ME en
// CUALQUIER lugar (`grep -q 'CHANGE_ME'`), comentarios incluidos. El ejemplo tiene que poder copiarse
// y completarse reemplazando solo los valores: si un comentario menciona la cadena, el despliegue se
// niega hasta que alguien lo borre a mano (pasó con el comentario de cabecera).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = readFileSync(join(root, 'infra', 'docker', 'server.env.example'), 'utf8');
const lines = example.split('\n');

describe('infra/docker/server.env.example', () => {
  it('ningún comentario contiene CHANGE_ME: solo los valores a reemplazar', () => {
    const offenders = lines.filter(
      (line) => line.trimStart().startsWith('#') && line.includes('CHANGE_ME'),
    );
    assert.deepEqual(offenders, []);
  });

  it('CHANGE_ME aparece únicamente como valor de una variable (CLAVE=CHANGE_ME)', () => {
    const offenders = lines.filter(
      (line) => line.includes('CHANGE_ME') && !/^[A-Z_]+=CHANGE_ME$/.test(line),
    );
    assert.deepEqual(offenders, []);
  });

  it('reemplazar los valores alcanza para pasar el chequeo de deploy.sh', () => {
    const filled = example.replace(/=CHANGE_ME$/gm, '=valor');
    assert.equal(filled.includes('CHANGE_ME'), false);
  });

  it('hay valores para reemplazar (el ejemplo no quedó vacío)', () => {
    assert.ok(lines.filter((line) => /^[A-Z_]+=CHANGE_ME$/.test(line)).length >= 5);
  });

  it('deploy.sh sigue usando ese chequeo (si cambia, este test tiene que revisarse)', () => {
    const deploy = readFileSync(join(root, 'scripts', 'deploy.sh'), 'utf8');
    assert.match(deploy, /grep -q 'CHANGE_ME' "\$env_file"/);
  });
});
