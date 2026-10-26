import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { classesOf, undefinedClasses } from '../test/tailwind';

// El formulario usa el enrutador de Next y una Server Action, que necesitan servidor y navegador: acá solo
// se comprueba lo que se ve y lo que se anuncia al renderizar.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../app/(app)/proyectos/nuevo/actions', () => ({ createProjectAction: vi.fn() }));

import { CreateProjectForm } from './create-project-form';
import { ProjectList, type ProjectSummary } from './project-list';
import { parseVisibility } from './project-visibility-field';
import { ButtonLink } from './ui/button';
import { TextAreaField } from './ui/field';

async function expectEveryClassToExist(html: string) {
  const classes = classesOf(html).filter((name) => !name.startsWith('lucide'));
  expect(await undefinedClasses(classes)).toEqual([]);
}

const projects: ProjectSummary[] = [
  { id: 'p1', code: 'OBRA-12', name: 'Planta Norte', status: 'active', access_level: 'full' },
  {
    id: 'p2',
    code: 'OBRA-13',
    name: 'Depósito',
    status: 'planning',
    access_level: 'assigned',
  },
];

describe('ProjectList', () => {
  const html = renderToStaticMarkup(<ProjectList projects={projects} />);

  it('muestra nombre, código y estado en español, uno por proyecto', () => {
    expect(html).toContain('Planta Norte');
    expect(html).toContain('OBRA-12 · Activo');
    expect(html).toContain('OBRA-13 · En planificación');
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it('avisa cuando solo ve sus tareas, y solo entonces', () => {
    expect(html.match(/Ves solo tus tareas/g)).toHaveLength(1);
    expect(html).toContain('OBRA-13 · En planificación · Ves solo tus tareas');
  });

  it('sin enlaces ni botones todavía: el detalle llega con C5', () => {
    expect(html).not.toMatch(/<(a|button)\b/);
  });

  it('todas sus clases existen en el CSS de la web', async () => {
    await expectEveryClassToExist(html);
  });

  it('los cuatro estados de un proyecto tienen texto', () => {
    const states = (['planning', 'active', 'on_hold', 'archived'] as const).map((status) =>
      renderToStaticMarkup(
        <ProjectList projects={[{ ...projects[0], status } as ProjectSummary]} />,
      ),
    );
    expect(states[2]).toContain('En pausa');
    expect(states[3]).toContain('Archivado');
  });
});

describe('CreateProjectForm', () => {
  const html = renderToStaticMarkup(<CreateProjectForm />);

  it('pide código y nombre, con la etiqueta siempre visible', () => {
    expect(html).toContain('>Código</label>');
    expect(html).toContain('>Nombre</label>');
    expect(html).toContain('name="code"');
    expect(html).toContain('name="name"');
  });

  it('no pregunta el sitio (guía §8): con uno solo la API lo elige', () => {
    // Solo el texto visible: la clase `transition-colors` también contiene la cadena.
    // Ninguna etiqueta ni selector de sitio. "Del sitio" es una opción de visibilidad, otra cosa.
    expect(html).not.toMatch(/>\s*Sitio\s*</);
    expect(html).not.toContain('site_id');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('name="site_id"');
  });

  it('la descripción va dentro de "Más opciones", cerrado por defecto', () => {
    expect(html).toMatch(/<details(?![^>]*\sopen)[^>]*>/);
    expect(html).toContain('Más opciones');
    expect(html).toContain('<textarea');
    expect(html.indexOf('<textarea')).toBeGreaterThan(html.indexOf('<details'));
  });

  it('la visibilidad va en "Más opciones": dos opciones con radio, reservado marcado por defecto', () => {
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    const reserved = radios.find((radio) => radio.includes('value="reserved"'));
    const site = radios.find((radio) => radio.includes('value="site"'));
    expect(reserved).toContain('checked');
    expect(site).not.toContain('checked');
    for (const radio of radios) expect(radio).toContain('name="visibility"');
    expect(html).toContain('Reservado: lo ven la dirección y quienes tengan tareas en él');
    expect(html).toContain('Del sitio: lo ve todo el que trabaja en ese sitio');
    expect(html.indexOf('type="radio"')).toBeGreaterThan(html.indexOf('<details'));
  });

  it('una sola acción principal (submit con verbo) y cancelar como enlace', () => {
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('type="submit"');
    expect(html).toContain('>Crear proyecto</button>');
    expect(html).toMatch(/<a [^>]*href="\/proyectos"[^>]*>Cancelar<\/a>/);
  });

  it('no valida con el navegador y empieza sin errores', () => {
    expect(html).toContain('noValidate');
    expect(html).not.toContain('role="alert"');
  });

  it('todas sus clases existen en el CSS de la web', async () => {
    await expectEveryClassToExist(html);
  });
});

describe('parseVisibility', () => {
  it('site solo si lo eligieron; todo lo demás es reservado', () => {
    expect(parseVisibility('site')).toBe('site');
    expect(parseVisibility('reserved')).toBe('reserved');
    expect(parseVisibility(null)).toBe('reserved');
    expect(parseVisibility('cualquier cosa')).toBe('reserved');
  });
});

describe('ButtonLink', () => {
  it('es un enlace real con el aspecto del botón principal', async () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/proyectos/nuevo">Nuevo proyecto</ButtonLink>,
    );
    expect(html).toMatch(/^<a [^>]*href="\/proyectos\/nuevo"/);
    expect(html).not.toContain('<button');
    expect(classesOf(html)).toEqual(
      expect.arrayContaining(['bg-primary', 'text-on-primary', 'min-h-control']),
    );
    await expectEveryClassToExist(html);
  });

  it('la variante secundaria usa la superficie y el borde decorativo', async () => {
    const html = renderToStaticMarkup(
      <ButtonLink href="/proyectos" variant="secondary">
        Cancelar
      </ButtonLink>,
    );
    expect(classesOf(html)).toEqual(expect.arrayContaining(['bg-surface', 'border-border']));
    await expectEveryClassToExist(html);
  });
});

describe('TextAreaField', () => {
  it('etiqueta asociada, ayuda y error vinculados, como el campo de una línea', async () => {
    const html = renderToStaticMarkup(
      <TextAreaField label="Descripción" hint="Opcional." error="Es demasiado larga." />,
    );
    const labelFor = html.match(/<label for="([^"]+)"/)?.[1];
    expect(html).toContain(`<textarea id="${labelFor}"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/aria-describedby="[^"]+ [^"]+"/);
    expect(classesOf(html)).toContain('border-border-strong');
    await expectEveryClassToExist(html);
  });
});
