# Edges

A semantic token doc for the edge role group. [ui-semantic-tokens.md](../../authoring/ui-semantic-tokens.md) is the rulebook. An edge token sets the line or the cast at the boundary of a region, never its fill or its text.

The roster: `--edge`, `--rome-shadow-surface`, `--border`, `--border-strong`, `--border-subtle`, `--input`.

A region has two kinds of boundary. A container's outline says where a card, a panel or a dialog ends and the canvas begins. A divider says where one row ends and the next begins inside a container. Ember and Slate draw both with a hairline. Ash draws the outline with a fill step and a cast, and fades the divider. The tokens name the two boundaries apart so that one theme can make that call. `[mech]`

## Why this name

`--edge` names the outline of a container, and `--rome-shadow-surface` names the cast a container carries at rest. Neither says whether the boundary is a line or a shadow, because the theme decides that: Ash resolves `--edge` to nearly nothing and the cast to a step, Ember resolves `--edge` to its hairline and the cast to `none`. A name built on the drawing, such as `--card-border`, would be false in one theme. `--border` and its neighbors keep their shadcn names and mean the divider. `[llm]`

> Prefer: `border-edge shadow-surface` on a panel, because the panel is a raised container and the theme owns how a container separates from the canvas.
> Over: `border-border` on a panel, because it draws a hairline today and a hairline is what the mockup shows.

## Usage statement

- `--edge` — Used for the outline of a raised container: a card, a form group, a table frame, a dialog, a floating box. Not used for the line between two rows inside one.
- `--rome-shadow-surface` — Used alongside `--edge` on the same container, for the cast it carries at rest. Not used on a popover or menu, which read a numbered step of their own.
- `--border` — Used for a divider between rows, a table rule, a tab strip's baseline, the outline of an outline button or badge. Not used for a container's outline.
- `--border-strong` — Used for a divider where `--border` reads too faint, such as a user's chat bubble against the muted fill. Not used to outline a container more firmly.
- `--border-subtle` — Used for the divider in a dense list. Not used where two rows need to read apart at a glance.
- `--input` — Used for the edge of a field, a checkbox and a radio, so a control reads as a control before focus. Not used for a divider.

## Theme mapping

Ash's dark half keeps Ember's depths and supplies its own edge and divider values. `--rome-shadow-surface` aliases a step of the [elevation scale](../primitive-token/elevation-primitives.md).

| Token | Ember light | Ember dark | Ash light | Ash dark | Slate light | Slate dark |
|---|---|---|---|---|---|---|
| `--edge` | `--neutral-150` | `--neutral-700` | `--neutral-900` at 5% | `--neutral-50` at 8% | `--neutral-200` | `--neutral-700` |
| `--rome-shadow-surface` | `none` | `none` | `--rome-shadow-4` | `--rome-shadow-4` | `none` | `none` |
| `--border` | `--neutral-150` | `--neutral-700` | `--neutral-900` at 8% | `--neutral-50` at 10% | `--neutral-200` | `--neutral-700` |
| `--border-strong` | `--neutral-300` | `--neutral-650` | `--neutral-900` at 16% | `--neutral-50` at 18% | `--neutral-300` | `--neutral-650` |
| `--border-subtle` | `--neutral-100` | `--neutral-850` | `--neutral-900` at 5% | `--neutral-50` at 6% | `--neutral-100` | `--neutral-800` |
| `--input` | `--neutral-150` | `--neutral-700` | `--neutral-300` | `--neutral-700` | `--neutral-200` | `--neutral-700` |

"At n%" is a `color-mix` of the named step into transparent. Ash's lines are ink at an alpha rather than a step, so a divider reads the same on the canvas, on a card and on a tinted well. Its field edge stays a solid step, so a control keeps reading as a control while the dividers fade. `[mech]`

## Constraints

- `--edge` and `--rome-shadow-surface` travel together. A container that writes one without the other has no boundary in one theme: no edge and no cast in Ash, or a hairline plus no cast in Ember, which is what `--border` already gives. `[mech]`
- A container's fill sits above the canvas in every theme. In Ash the fill step is what separates the container once the edge is nearly gone, so `--edge` on a region painted `--background` marks nothing. `[mech]`
- The cast is a step of the elevation scale or `none`, never a list written at the call site, and it never carries a 1px layer standing in for the edge. `[mech]`
- Dividers are not measured for contrast. A row is identified by its content and its hover fill, and the line is decoration, which is why Ash can fade it to 8%. `[mech]`
- A field's edge stays solid in Ash because it identifies a control at rest. Fading it to the divider alpha turns a field into a well. `[mech]`

## Examples

- Positive: a settings group written `border border-edge bg-surface shadow-surface` with `divide-y divide-border` between its rows. In Ember the group outlines itself with a hairline and its rows divide with the same one. In Ash the group lifts on a cast and the rows divide with an 8% line.
- Negative: a recap card written `border border-border-strong bg-surface`. It reads firmly outlined in Ember, which is the intent, and it keeps a 16% line around it in Ash, where the cards beside it carry no line at all.
