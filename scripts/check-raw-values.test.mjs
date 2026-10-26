// Tests de scripts/check-raw-values.mjs. Corren con el ejecutor nativo de Node:
//   node --test scripts/
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findRawValues, scanDirectories } from './check-raw-values.mjs';

const values = (source) => findRawValues(source).map((finding) => finding.value);

describe('findRawValues: colores', () => {
  it('marca hexadecimales de 3, 4, 6 y 8 dígitos', () => {
    assert.deepEqual(
      values("const a = '#fff'; const b = '#FFFF'; const c = '#1F4FD1'; const d = '#1f4fd1cc';"),
      ['#fff', '#FFFF', '#1F4FD1', '#1f4fd1cc'],
    );
  });

  it('marca el hexadecimal dentro de una clase de Tailwind y de un estilo CSS', () => {
    assert.deepEqual(values('<div className="bg-[#1F4FD1] p-4" />'), ['#1F4FD1']);
    assert.deepEqual(values('.a { color: #16181d; }'), ['#16181d']);
  });

  it('marca las funciones de color', () => {
    assert.deepEqual(
      values(
        'color: rgb(0 0 0); background: rgba(0,0,0,.5); x: hsl(10 20% 30%); y: oklch(0.5 0.1 200)',
      ),
      ['rgb(', 'rgba(', 'hsl(', 'oklch('],
    );
  });

  it('no marca lo que no es un color', () => {
    assert.deepEqual(
      values('<a href="#top">x</a> &#123; &#x1F4A9; var(--color-bg) id="#abcdefg"'),
      [],
    );
    assert.deepEqual(values('const x = a#b; url(/img/foo#fragment)'), []);
  });

  it('un color del tema no se marca', () => {
    assert.deepEqual(values('<div className="bg-surface text-text border-border-strong" />'), []);
    assert.deepEqual(values('color: var(--color-primary);'), []);
  });
});

describe('findRawValues: tamaños', () => {
  it('marca valores arbitrarios de Tailwind con unidad fija', () => {
    assert.deepEqual(values('className="p-[13px] text-[0.8rem] mt-[-4px] w-[2em]"'), [
      '[13px]',
      '[0.8rem]',
      '[-4px]',
      '[2em]',
    ]);
  });

  it('no marca la escala ni valores arbitrarios sin unidad fija', () => {
    assert.deepEqual(
      values('className="p-4 gap-8 grid-cols-[1fr_2fr] w-[calc(100%-1rem)] h-[100vh]"'),
      [],
    );
  });
});

describe('findRawValues: comentarios y salida de emergencia', () => {
  it('ignora los comentarios', () => {
    assert.deepEqual(values('// el azul era #1F4FD1\nconst a = 1;\n/* y rgb(0 0 0) */'), []);
    assert.deepEqual(values('/*\n * #FFFFFF\n */'), []);
  });

  it('una URL con // no oculta lo que viene después en otra línea', () => {
    assert.deepEqual(values("fetch('https://example.com');\nconst c = '#fff';"), ['#fff']);
  });

  it('informa línea y columna', () => {
    const [finding] = findRawValues("const a = 1;\nconst b = '#fff';");
    assert.equal(finding.line, 2);
    assert.equal(finding.column, 12);
  });

  it('raw-values-ok CON motivo, en la misma línea o en la de arriba, permite el valor', () => {
    assert.deepEqual(values("const a = '#fff'; // raw-values-ok: lo exige el SDK de pagos"), []);
    assert.deepEqual(values("// raw-values-ok: lo exige el SDK de pagos\nconst a = '#fff';"), []);
  });

  it('raw-values-ok SIN motivo no vale', () => {
    assert.deepEqual(values("const a = '#fff'; // raw-values-ok:"), ['#fff']);
    assert.deepEqual(values("const a = '#fff'; // raw-values-ok"), ['#fff']);
  });

  it('la salida de emergencia solo cubre su línea y la siguiente', () => {
    assert.deepEqual(values("// raw-values-ok: motivo\nconst a = '#fff';\nconst b = '#000';"), [
      '#000',
    ]);
  });
});

describe('scanDirectories', () => {
  function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), 'raw-values-'));
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return root;
  }

  it('escanea componentes y estilos, y saltea specs, tests y carpetas generadas', () => {
    const root = fixture({
      'a/Button.tsx': "const c = '#fff';",
      'a/estilos.css': 'a { color: rgb(0 0 0); }',
      'a/Button.spec.tsx': "const c = '#fff';",
      'a/util.test.ts': "const c = '#fff';",
      'a/node_modules/x/index.js': "const c = '#fff';",
      'a/.next/static/x.js': "const c = '#fff';",
      'a/dist/x.js': "const c = '#fff';",
      'a/ok.tsx': 'const c = 1;',
      'a/nota.md': 'color #fff',
    });
    try {
      const found = scanDirectories([join(root, 'a')]).map((r) =>
        r.file.replace(`${root}`, '').replaceAll('\\', '/'),
      );
      assert.deepEqual(found.sort(), ['/a/Button.tsx', '/a/estilos.css']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('una carpeta que no existe (apps/mobile todavía no está) se saltea', () => {
    assert.deepEqual(scanDirectories(['/no/existe/para/nada']), []);
  });
});
