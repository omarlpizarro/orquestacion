// pnpm resuelve los paquetes a través de un store virtual
// (node_modules/.pnpm/<nombre>@<version>/node_modules/<nombre>/...), no al
// layout plano de npm/yarn. Un patrón anclado que solo contempla
// `node_modules/pg` nunca matchea ahí y la regla queda muda en silencio.
// Como `to.path` no ancla el regex, alcanza con buscar la subcadena
// `node_modules/<paquete>/`, que aparece en las dos variantes de layout.
// (Un regex con grupos cuantificados acá dispara el chequeo anti-ReDoS de
// dependency-cruiser y aborta el análisis entero — mejor mantenerlo simple.)
function npmPackage(name) {
  return `node_modules/${name}/`;
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment:
        'Un módulo de NestJS solo puede importar el archivo de módulo (o index) de otro, nunca sus internals (CLAUDE.md §5).',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/[^/]+\\.module\\.ts$'],
      },
    },
    {
      name: 'no-cross-module-schema',
      severity: 'error',
      comment: 'Regla dura 5: ningún módulo toca el esquema Drizzle de otro módulo.',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: { path: '^packages/db/src/schema/([^/]+)/', pathNot: '^packages/db/src/schema/$1/' },
    },
    {
      name: 'no-app-to-app',
      severity: 'error',
      comment: 'Una app nunca importa el código fuente de otra app.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/([^/]+)/src', pathNot: '^apps/$1/' },
    },
    {
      name: 'only-database-layer-touches-the-driver',
      severity: 'error',
      comment:
        'Regla dura 3: todo acceso a datos pasa por el helper de transacción de packages/db. Nadie más abre una conexión ni importa el driver.',
      from: {
        path: '^apps/(api|worker)/src/',
        pathNot: '^apps/(api|worker)/src/shared/database/',
      },
      to: { path: npmPackage('pg') },
    },
    {
      name: 'orpc-stays-at-the-edge',
      severity: 'error',
      comment:
        'Regla de contención de ADR-005: @orpc/* solo en controllers y en el cliente de apps/web. Si oRPC se abandona, el resto del código no lo sabe.',
      from: {
        path: '^apps/',
        pathNot:
          '(\\.controller\\.ts$|^apps/web/src/lib/api\\.ts$|^apps/api/src/app\\.module\\.ts$)',
      },
      to: { path: npmPackage('@orpc') },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: '`domain/` no conoce Nest, Drizzle ni infraestructura.',
      from: { path: '^apps/api/src/modules/[^/]+/domain/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/infrastructure/',
      },
    },
    {
      name: 'contracts-stay-pure',
      severity: 'error',
      comment: 'packages/contracts no conoce base de datos, Nest ni React.',
      from: { path: '^packages/contracts/' },
      to: {
        path: [
          '^packages/db/',
          npmPackage('@nestjs'),
          npmPackage('pg'),
          npmPackage('drizzle-orm'),
          npmPackage('react'),
          npmPackage('next'),
        ],
      },
    },
    {
      name: 'no-db-from-web',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: ['^packages/db/', npmPackage('pg'), npmPackage('drizzle-orm')] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Código de src/ no depende de devDependencies (testcontainers, vitest, etc), salvo el propio arnés de testing exportado por packages/db/src/testing.',
      from: {
        path: '^(apps|packages)/[^/]+/src/',
        pathNot: ['\\.spec\\.ts$', '^packages/db/src/testing/'],
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    tsPreCompilationDeps: true,
    // `doNotFollow` alcanza para no recorrer adentro de node_modules. Si
    // `node_modules` también entra en `exclude`, dependency-cruiser borra la
    // ARISTA hacia el paquete externo, no solo el recorrido interno — y las
    // reglas que apuntan a un paquete npm (pg, @orpc/*) dejan de disparar
    // en silencio. No repetir ese error.
    doNotFollow: { path: 'node_modules' },
    // Anclado a apps/<paquete>/... y packages/<paquete>/...: un patrón sin
    // anclar excluye cualquier /dist/ que aparezca en la ruta, y los propios
    // paquetes de node_modules (@orpc/server, por ejemplo) publican su build
    // en dist/ — eso borraba esas aristas en silencio, igual que el error
    // anterior con node_modules a secas.
    exclude: {
      path: '^(apps|packages)/[^/]+/(dist|\\.next|\\.turbo|coverage)/|^packages/db/migrations/meta/',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
