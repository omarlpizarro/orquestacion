import { TASK_STATUSES, taskStatusLabels } from '@orq/ui-tokens';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { classesOf, undefinedClasses } from '../../test/tailwind';
import { BrandMark } from './brand-mark';
import { Button } from './button';
import { EmptyState } from './empty-state';
import { Field } from './field';
import { StatusChip } from './status-chip';

/** Cada clase que usa un componente tiene que hacer algo: con el tema anulado, una mal escrita no falla. */
async function expectEveryClassToExist(html: string) {
  // `lucide` y `lucide-<ícono>` son las marcas propias de Lucide en el SVG, no clases de Tailwind.
  const classes = classesOf(html).filter((name) => !name.startsWith('lucide'));
  expect(await undefinedClasses(classes)).toEqual([]);
}

describe('Button', () => {
  it.each(['primary', 'secondary', 'destructive'] as const)(
    '%s: es un <button> real, de tipo button',
    async (variant) => {
      const html = renderToStaticMarkup(<Button variant={variant}>Guardar</Button>);

      expect(html).toMatch(/^<button type="button"/);
      expect(html).toContain('Guardar');
      await expectEveryClassToExist(html);
    },
  );

  it('la variante por defecto es la principal', () => {
    const html = renderToStaticMarkup(<Button>Agregar tarea</Button>);
    expect(html).toContain('bg-primary');
    expect(html).toContain('text-on-primary');
  });

  it('mide 48 de alto (control) y el de ícono, 44 × 44 (zona táctil mínima)', () => {
    expect(renderToStaticMarkup(<Button>Guardar</Button>)).toContain('min-h-control');
    const icon = renderToStaticMarkup(
      <Button variant="icon" aria-label="Abrir tarea">
        <svg aria-hidden="true" />
      </Button>,
    );
    expect(icon).toContain('size-touch');
  });

  it('el botón de ícono lleva aria-label', () => {
    const html = renderToStaticMarkup(
      <Button variant="icon" aria-label="Abrir tarea">
        <svg aria-hidden="true" />
      </Button>,
    );
    expect(html).toContain('aria-label="Abrir tarea"');
  });

  it('el destructivo se oscurece al presionarlo (danger-pressed), solo si está habilitado', () => {
    const html = renderToStaticMarkup(<Button variant="destructive">Quitar</Button>);
    expect(html).toContain('enabled:hover:bg-danger-pressed');
    expect(html).toContain('enabled:active:bg-danger-pressed');
  });

  it('el principal puede ocupar el ancho completo', () => {
    expect(renderToStaticMarkup(<Button fullWidth>Guardar</Button>)).toContain('w-full');
    expect(renderToStaticMarkup(<Button>Guardar</Button>)).not.toContain('w-full');
  });

  it('deshabilitado: atributo real y estilo de la guía (text-disabled sobre surface-2, sin borde)', () => {
    const html = renderToStaticMarkup(<Button disabled>Guardar</Button>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('disabled:bg-surface-2');
    expect(html).toContain('disabled:text-text-disabled');
    // El hover del principal solo vale si está habilitado.
    expect(html).toContain('enabled:hover:bg-primary-pressed');
  });

  it('un submit sigue siendo submit si se lo pide', () => {
    expect(renderToStaticMarkup(<Button type="submit">Entrar</Button>)).toMatch(
      /^<button type="submit"/,
    );
  });

  it('todas las variantes y estados usan clases que existen', async () => {
    const html = [
      renderToStaticMarkup(
        <Button disabled fullWidth>
          x
        </Button>,
      ),
      renderToStaticMarkup(
        <Button variant="secondary" disabled>
          x
        </Button>,
      ),
      renderToStaticMarkup(
        <Button variant="destructive" disabled>
          x
        </Button>,
      ),
      renderToStaticMarkup(
        <Button variant="icon" aria-label="x" disabled>
          x
        </Button>,
      ),
    ].join('');
    await expectEveryClassToExist(html);
  });
});

describe('StatusChip', () => {
  it.each(TASK_STATUSES)('%s: muestra ícono Y texto, nunca solo color', async (status) => {
    const html = renderToStaticMarkup(<StatusChip status={status} />);

    expect(html).toContain(taskStatusLabels[status]);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    await expectEveryClassToExist(html);
  });

  it.each(TASK_STATUSES)('%s: usa los colores de SU estado, no los de otro', (status) => {
    const html = renderToStaticMarkup(<StatusChip status={status} />);
    const slug = status.replaceAll('_', '-');
    expect(html).toContain(`bg-status-${slug}-bg`);
    expect(html).toContain(`text-status-${slug}-text`);
  });

  it('cada estado tiene un ícono distinto', () => {
    const paths = TASK_STATUSES.map((status) => {
      const html = renderToStaticMarkup(<StatusChip status={status} />);
      return html.match(/lucide-([a-z-]+)/)?.[1];
    });
    expect(new Set(paths).size).toBe(TASK_STATUSES.length);
  });

  it('el relleno es 4 × 8, de la escala de espaciado', () => {
    const classes = classesOf(renderToStaticMarkup(<StatusChip status="done" />));
    expect(classes).toContain('py-4');
    expect(classes).toContain('px-8');
  });

  it('no es tocable: no es un botón ni un enlace', () => {
    const html = renderToStaticMarkup(<StatusChip status="blocked" />);
    expect(html).toMatch(/^<span/);
    expect(html).not.toMatch(/<(button|a)\b/);
  });
});

describe('Field', () => {
  it('la etiqueta está siempre visible y asociada al campo', () => {
    const html = renderToStaticMarkup(<Field label="Correo" name="email" />);

    const labelFor = html.match(/<label for="([^"]+)"/)?.[1];
    const inputId = html.match(/<input[^>]* id="([^"]+)"/)?.[1];
    expect(labelFor).toBeTruthy();
    expect(labelFor).toBe(inputId);
    expect(html).toContain('>Correo</label>');
  });

  it('el borde del campo es border-strong (3:1), no el decorativo', () => {
    const html = renderToStaticMarkup(<Field label="Correo" />);
    expect(classesOf(html)).toContain('border-border-strong');
    expect(classesOf(html)).not.toContain('border-border');
    expect(html).toContain('min-h-control');
  });

  it('el error va debajo, con ícono, anunciado y vinculado al campo', async () => {
    const html = renderToStaticMarkup(<Field label="Correo" error="Escribí tu correo." />);

    expect(html).toContain('role="alert"');
    expect(html).toContain('Escribí tu correo.');
    expect(html).toContain('aria-invalid="true"');
    const errorId = html.match(/<p id="([^"]+)" role="alert"/)?.[1];
    expect(html).toContain(`aria-describedby="${errorId}"`);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    await expectEveryClassToExist(html);
  });

  it('sin error no hay aria-invalid ni alerta', () => {
    const html = renderToStaticMarkup(<Field label="Correo" />);
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('role="alert"');
  });

  it('la ayuda se vincula al campo', () => {
    const html = renderToStaticMarkup(<Field label="Correo" hint="El que usás en el trabajo." />);
    const hintId = html.match(/<p id="([^"]+)"/)?.[1];
    expect(html).toContain(`aria-describedby="${hintId}"`);
  });

  it('pasa los atributos nativos del campo (tipo, autocompletado, nombre)', () => {
    const html = renderToStaticMarkup(
      <Field label="Contraseña" name="password" type="password" autoComplete="current-password" />,
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autoComplete="current-password"');
  });

  it('dos campos tienen ids distintos', () => {
    const html = renderToStaticMarkup(
      <>
        <Field label="A" />
        <Field label="B" />
      </>,
    );
    const ids = [...html.matchAll(/<input[^>]* id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it('todas sus clases existen, con y sin ayuda', async () => {
    const html = renderToStaticMarkup(<Field label="A" hint="ayuda" disabled />);
    await expectEveryClassToExist(html);
  });
});

describe('EmptyState', () => {
  it('dice qué va a aparecer, y puede traer una acción para empezar', async () => {
    const html = renderToStaticMarkup(
      <EmptyState action={<Button>Agregar proyecto</Button>}>
        Acá van a aparecer tus proyectos.
      </EmptyState>,
    );

    expect(html).toContain('Acá van a aparecer tus proyectos.');
    expect(html).toContain('Agregar proyecto');
    await expectEveryClassToExist(html);
  });

  it('sin acción es solo el texto', () => {
    const html = renderToStaticMarkup(<EmptyState>Nada por acá.</EmptyState>);
    expect(html).not.toContain('<button');
  });
});

describe('BrandMark', () => {
  it('lleva la palabra Batuta, con el dibujo oculto a los lectores de pantalla', async () => {
    const html = renderToStaticMarkup(<BrandMark />);
    expect(html).toContain('>Batuta<');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    await expectEveryClassToExist(html);
  });
});
