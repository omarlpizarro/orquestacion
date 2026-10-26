/**
 * Marca PROVISORIA de Batuta (docs/design-guidelines.md §13): una línea diagonal con un círculo en el
 * mango, en `primary`, junto a la palabra en Manrope 700. Provisoria hasta que exista un logotipo
 * definitivo; no se usa en materiales externos.
 */
export function BrandMark() {
  return (
    <span className="inline-flex items-center gap-8">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="size-icon-button text-primary"
      >
        <line x1="19" y1="5" x2="8" y2="16" />
        <circle cx="5.5" cy="18.5" r="2.5" />
      </svg>
      <span className="text-section-title font-bold text-text">Batuta</span>
    </span>
  );
}
