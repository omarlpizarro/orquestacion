# Guía de diseño de Batuta

Reglas obligatorias para toda interfaz del producto: dashboard web y app móvil.
Si una pantalla necesita algo que esta guía no cubre, se propone el agregado y
se discute antes de implementarlo. No se inventan colores, tamaños ni
componentes por fuera de lo que está acá.

Modelo elegido: **C · Pizarra y Cobalto**. Referencia visual: el lienzo
"Batuta — Propuestas visuales" (privado de Omar).

---

## 1. Principios

Batuta coordina el trabajo de gente que no está sentada frente a una
computadora: encargados de local, capataces, personal de campo. La interfaz se
usa con apuro, al sol, con guantes, en teléfonos de gama baja y media, y a
veces sin señal. Cuatro principios ordenan todas las decisiones:

1. **Sencillo.** Una acción principal por pantalla. Solo los campos
   obligatorios a la vista. Nada decorativo.
2. **Intuitivo.** Elegir antes que tipear. Los mismos componentes significan
   siempre lo mismo. El estado de una tarea se entiende de un vistazo.
3. **Sólido y confiable.** Colores sobrios y fríos, contraste alto, formas
   firmes. Nada que parezca de juguete o que distraiga.
4. **Pensado para el campo.** Legible al sol y de noche, operable con guantes,
   liviano para teléfonos modestos.

---

## 2. Color

Una paleta casi monocroma de grises pizarra, con el azul cobalto como **único**
color de marca. Todos los valores salen de los tokens (sección 11): **nunca se
escribe un hexadecimal suelto en un componente.**

### 2.1 Tokens base

| Token | Claro | Oscuro | Uso |
| --- | --- | --- | --- |
| `bg` | `#F5F5F6` | `#101114` | Fondo de pantalla |
| `surface` | `#FFFFFF` | `#191B20` | Tarjetas, barras, hojas |
| `surface-2` | `#EEEFF1` | `#22252B` | Fondos sutiles, filas alternas, presionado |
| `border` | `#DCDDE1` | `#2B2E36` | Bordes de 1 px |
| `text` | `#16181D` | `#ECEDF0` | Texto principal |
| `text-2` | `#50545E` | `#A3A7B1` | Texto secundario, metadatos |
| `text-disabled` | `#9A9DA6` | `#5C606B` | Solo elementos deshabilitados |
| `primary` | `#1F4FD1` | `#7C9DF5` | Acción principal, enlaces, elemento activo |
| `primary-pressed` | `#173DA6` | `#9BB4F8` | Estado presionado de `primary` |
| `on-primary` | `#FFFFFF` | `#0B0D12` | Texto e íconos sobre `primary` |
| `danger` | `#B42318` | `#FF8A7A` | Acciones destructivas |
| `on-danger` | `#FFFFFF` | `#0B0D12` | Texto sobre `danger` |
| `focus` | `#1F4FD1` | `#7C9DF5` | Anillo de foco |

Todas las combinaciones de texto cumplen al menos 4.5:1 de contraste. Si se
agrega un color nuevo, tiene que cumplirlo también, verificado.

### 2.2 Reglas

- **El cobalto es escaso a propósito.** Se usa para la acción principal, el
  elemento activo de la navegación y los enlaces. Si todo es azul, nada
  destaca.
- **`danger` no es un estado de tarea.** Es para acciones destructivas
  (cancelar, quitar un miembro). Los colores de estado son otra familia
  (sección 3).
- **Sin degradados, sin sombras, sin transparencias decorativas.** La
  jerarquía se arma con superficies y bordes de 1 px. Esto además es más
  liviano para teléfonos de gama baja.

---

## 3. Estados de tarea

Los seis estados tienen colores fijos, iguales en todo el producto y
**independientes de la marca**: si algún día cambia la paleta, los estados no
cambian.

| Estado | Ícono | Claro (texto / fondo) | Oscuro (texto / fondo) |
| --- | --- | --- | --- |
| Pendiente | círculo vacío | `#4B5563` / `#EEF0F3` | `#C3C9D2` / `#2A2F38` |
| En curso | triángulo de reproducir | `#1D4ED8` / `#E3EBFD` | `#8DB0FF` / `#172A4D` |
| Bloqueada | círculo tachado | `#C4320A` / `#FDE7E5` | `#FF9C7A` / `#3D1A12` |
| En revisión | ojo | `#6E3BC2` / `#EFE8FB` | `#C4A6FF` / `#2A1E45` |
| Terminada | tilde | `#067647` / `#E3F4EA` | `#6FD49B` / `#12301F` |
| Cancelada | cruz | `#5F6673` / `#F1F2F4` | `#9AA1AC` / `#23262C` |

Reglas:

- **Un estado se muestra siempre con ícono y texto, nunca solo con color.**
  Hay personas que no distinguen el rojo del verde, y al sol los colores se
  lavan.
- El chip de estado es siempre el mismo componente (sección 7.2).
- **Vencida** no es un estado: es una condición que puede tener una tarea
  pendiente, en curso o bloqueada. Se marca con el color de Bloqueada en el
  texto de la hora, con ícono de reloj y la palabra "Venció" o "Vencida".

---

## 4. Tipografía

**Manrope**, una sola familia, en cuatro pesos: 400, 500, 600 y 700.

**La fuente se empaqueta con la app y con la web, nunca se carga de Google
Fonts en tiempo de ejecución.** La app es offline-first, y un teléfono sin
señal no puede descargar una fuente.

| Rol | Tamaño | Peso | Interlineado | Uso |
| --- | --- | --- | --- | --- |
| Título de pantalla | 28 | 700 | 1.15 | Uno por pantalla ("Mi Día") |
| Título de sección | 20 | 600 | 1.25 | Encabezados dentro de una pantalla |
| Título de tarea | 17 | 600 | 1.3 | Nombre de una tarea o proyecto en una tarjeta |
| Cuerpo | 16 | 400 | 1.45 | Texto general, descripciones |
| Botón | 16 | 600 | 1 | Texto de botones |
| Secundario | 14 | 400 o 500 | 1.35 | Metadatos, horas, ayudas |
| Etiqueta | 13 | 700, mayúsculas, espaciado 0.06em | 1 | Rótulos de sección ("VENCIDAS") |

Reglas:

- **Nada por debajo de 13 px.** En el campo no se lee.
- Horas, fechas y cantidades con cifras tabulares (`font-variant-numeric:
  tabular-nums`), para que no bailen al alinearse.
- La app respeta el tamaño de letra del sistema del teléfono hasta 130 % sin
  que se rompa ningún diseño. Se prueba.

---

## 5. Espaciado y forma

- **Escala de espaciado:** 4, 8, 12, 16, 20, 24, 32, 48. Ningún otro valor.
- **Márgenes de pantalla en móvil:** 16 a los lados.
- **Radios:** 10 para botones y campos, 14 para tarjetas, totalmente
  redondeado para chips.
- **Bordes:** 1 px, color `border`. Nunca más gruesos salvo el anillo de foco.

---

## 6. Interacción táctil

- **Toda zona tocable mide al menos 44 × 44 px.** Sin excepciones, también los
  íconos.
- **Los botones principales miden 48 px de alto.** En móvil, la acción
  principal ocupa el ancho completo.
- **Al menos 8 px entre dos zonas tocables**, para no tocar la equivocada con
  un guante.
- **Una sola acción principal por pantalla.** Si hay dos acciones igual de
  importantes, el diseño está mal.
- **Confirmación solo para lo irreversible:** cancelar una tarea, quitar a
  alguien de un proyecto. Nunca para acciones comunes como marcar terminada,
  que además es reversible.
- **Respuesta inmediata:** todo toque cambia algo visible en menos de 100 ms,
  aunque la operación siga en segundo plano.

---

## 7. Componentes

Esta lista es cerrada. Un componente nuevo se propone antes de construirlo.

### 7.1 Botones

| Variante | Fondo | Texto | Borde | Uso |
| --- | --- | --- | --- | --- |
| Principal | `primary` | `on-primary` | — | La acción principal de la pantalla |
| Secundario | `surface` | `text` | `border` | Acciones complementarias |
| Destructivo | `danger` | `on-danger` | — | Cancelar, quitar, borrar |
| Ícono | transparente | `text-2` | `border` | Acciones compactas; siempre con `aria-label` |

Alto 48 (íconos 44 × 44), radio 10, texto 16/600. Deshabilitado:
`text-disabled` sobre `surface-2`, sin borde.

### 7.2 Chip de estado

Ícono de 15 px más texto de 13 o 14 px en peso 600, colores de la sección 3,
radio completo, relleno 5 × 10. No es tocable.

### 7.3 Tarjeta de tarea

La unidad básica de Batuta. Fondo `surface`, borde 1 px, radio 14, relleno 14
× 16. De arriba hacia abajo:

1. **Fila superior:** chip de estado a la izquierda; hora a la derecha, con
   ícono de reloj (en color de vencida si corresponde).
2. **Título** de la tarea (17/600) y, debajo, el contexto (14, `text-2`):
   sector, prioridad.
3. **Botón de ícono** a la derecha para abrir la tarea.
4. **Opcional:** el motivo de un bloqueo, en un recuadro con el fondo del
   estado Bloqueada; o la acción principal de la tarea, a ancho completo.

Prohibido: bordes izquierdos de color como indicador, sombras, fondos de
color en la tarjeta entera.

### 7.4 Navegación inferior (móvil)

Cuatro destinos como máximo: Mi Día, Proyectos, Alertas, Perfil. Alto 64.
Ícono de 22 más texto de 12. El destino activo va en `primary`, peso 700 y con
una barra de 32 × 3 px arriba. Los inactivos, en `text-2`.

### 7.5 Campos de formulario

- Etiqueta **siempre visible arriba** del campo, nunca solo como texto de
  ejemplo adentro.
- Alto 48, radio 10, borde 1 px, fondo `surface`.
- Error debajo del campo, en `danger`, con ícono, diciendo qué hacer ("Elegí
  un responsable"), no qué salió mal en términos técnicos.
- Selección antes que escritura: listas, selectores de fecha y hora, botones
  de opción.

### 7.6 Estados vacíos

Una línea que explica qué va a aparecer ahí y, si corresponde, una acción para
empezar. Sin ilustraciones decorativas.

### 7.7 Íconos

Un solo conjunto: **Lucide**, trazo de 2 px sobre grilla de 24. Tamaños: 15
en chips, 20 en botones, 22 en la navegación. Nunca emojis.

---

## 8. Formularios mínimos

- **Solo los campos obligatorios a la vista.** El resto, dentro de "Más
  opciones", cerrado por defecto.
- **No se pregunta lo que el sistema ya sabe.** En una organización de un
  solo sitio, el formulario de proyecto no muestra el campo sitio. Si hay una
  sola opción posible, se elige sola.
- **Valores por defecto razonables:** hoy como fecha, el usuario actual como
  responsable cuando tiene sentido.
- Un formulario largo se parte en pasos. Más de seis campos visibles a la vez
  es señal de que algo sobra.

---

## 9. Modo oscuro

- **Por defecto sigue la configuración del sistema**, con un ajuste manual en
  Perfil: claro, oscuro o automático.
- **Nunca negro puro.** El fondo es `#101114`: cansa menos la vista en turnos
  nocturnos y evita el efecto de arrastre en pantallas baratas.
- **Misma estructura en los dos modos.** Solo cambian los tokens. Toda
  pantalla se prueba en ambos antes de darse por terminada.

---

## 10. Accesibilidad

- Contraste mínimo 4.5:1 para texto, 3:1 para texto de 24 px o más e íconos
  con significado.
- Ningún dato se comunica solo con color.
- Todo botón de ícono lleva `aria-label` (web) o `accessibilityLabel`
  (móvil).
- En la web, el foco de teclado siempre visible: anillo de 2 px en `focus`,
  separado 2 px del elemento.
- Elementos reales para cada cosa: un botón es un botón, un enlace es un
  enlace. Nunca un `div` que se comporta como botón.

---

## 11. Implementación

### 11.1 Tokens como fuente única

Los valores de las secciones 2 a 5 viven en un solo paquete,
`packages/ui-tokens`, exportados como objeto TypeScript, y de ahí los consumen:

- **Web:** la configuración de Tailwind y variables CSS, con las de modo
  oscuro bajo `prefers-color-scheme` y bajo un atributo para el ajuste manual.
- **Móvil:** el tema de React Native.

Un componente nunca contiene un hexadecimal, un tamaño de fuente o un
espaciado escrito a mano: los toma del tema. Un hexadecimal suelto en un
componente es un defecto de revisión.

### 11.2 Rendimiento en gama baja

- Sin desenfoques, transparencias superpuestas ni sombras.
- Animaciones de 200 ms como máximo, y solo de opacidad o posición.
- Listas largas siempre virtualizadas.
- Imágenes comprimidas antes de subirlas, como ya define el modelo de datos.
- Una sola familia tipográfica, cuatro pesos, empaquetada.

---

## 12. Textos

- **Español rioplatense**, como el resto de la interfaz: "elegí", "tocá",
  "marcá".
- **Botones con verbo:** "Marcar terminada", "Agregar tarea", nunca "OK" o
  "Aceptar" sueltos.
- **Cortos.** Si un texto necesita dos líneas para explicar un botón, el
  botón está mal diseñado.
- **Errores que dicen qué hacer**, no qué falló por dentro. Nunca un código de
  error a la vista del usuario.

---

## 13. Marca

- Nombre: **Batuta**. Siempre con mayúscula inicial, nunca en mayúsculas
  sostenidas en el logotipo.
- Marca provisoria: la batuta, una línea diagonal con un círculo en el mango,
  en `primary`, junto a la palabra en Manrope 700. Es provisoria hasta que
  exista un logotipo definitivo; no se usa en materiales externos.
