# Elevation Primitives

A primitive token doc for the elevation dimension. [ui-primitive-tokens.md](../../authoring/ui-primitive-tokens.md) is the rulebook.

The scale is a set of names, and a theme supplies the values, one shadow list per name per mode half. The values live in `packages/web/src/lib/themes.ts`. That file stays authoritative: where this doc and the file disagree, the file is right and the doc updates. Every theme carries all of the names in both halves. `[mech]`

## Tokens

One flat scale, `--rome-shadow-*`, of four steps: 1, 4, 10 and 25. A step's number is its light-half y-offset in px, and a higher number is a higher surface in both halves. `[mech]`

A value is one or two layers. A layer holds an x-offset, a y-offset, a blur, a spread, and an ink. Ember and Slate supply the values below. Ash supplies the same dark half and its own light values at steps 4 and 10.

| Step | Light | Dark |
|---|---|---|
| `--rome-shadow-1` | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` | `0 1px 3px 0 rgb(0 0 0 / 0.45), 0 1px 2px -1px rgb(0 0 0 / 0.4)` |
| `--rome-shadow-4` | `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` | `0 6px 16px -2px rgb(0 0 0 / 0.55), 0 2px 6px -2px rgb(0 0 0 / 0.5)` |
| `--rome-shadow-10` | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` | `0 12px 28px -4px rgb(0 0 0 / 0.6), 0 4px 10px -4px rgb(0 0 0 / 0.5)` |
| `--rome-shadow-25` | `0 25px 50px -12px rgb(0 0 0 / 0.25)` | `0 25px 60px -12px rgb(0 0 0 / 0.7)` |

Ash's containers carry no hairline, so its casts do the work a line does elsewhere. Each is a thin contact layer that seats the container over a wide ambient layer that lifts it, in Ash's own ink rather than black so the cast warms with the canvas. These values sit below the alpha floor and past the blur ratio in the constraints below, by decision: at the scale's values a soft lift is impossible, since a cast dark enough to clear the floor reads as a rim and one blurred enough to stay soft is clipped by the ratio. The constraints hold for every other theme.

| Token | Ash light | Ash dark |
|---|---|---|
| `--rome-shadow-surface` | `0 1px 2px rgb(26 19 15 / 0.05), 0 6px 16px -6px rgb(26 19 15 / 0.1)` | `0 1px 2px rgb(0 0 0 / 0.3), 0 6px 18px -6px rgb(0 0 0 / 0.55)` |
| `--rome-shadow-4` | `0 2px 4px rgb(26 19 15 / 0.05), 0 16px 36px -10px rgb(26 19 15 / 0.16)` | shared |
| `--rome-shadow-10` | `0 2px 6px rgb(26 19 15 / 0.06), 0 16px 40px -8px rgb(26 19 15 / 0.2)` | shared |

Two semantic tokens sit beside the steps: `--rome-shadow-card-hover` reads step 4 in every theme, and `--rome-shadow-surface`, the cast a raised container carries at rest, is `none` in Ember and Slate and Ash's own value above. [edges.md](../semantic-token/edges.md) holds the second one's contract.

## How the scale is built

- **A step is a height, and the y-offset carries it.** The light-half offsets run 1, 4, 10 and 25. Each neighbor pair sits at 2.5× or more, because two casts with closer offsets read as one height. `[mech]`
- **Blur exceeds the y-offset on every layer.** The ratio runs 1.5× to 3× in the light half and 2× to 3× in the dark half, and it climbs as the offset falls: a 1px cast needs proportionally more blur than a 25px one to keep its edge off the surface. A blur under the offset hardens that edge into a line. `[mech]`
- **Spread never rises above zero.** A negative spread holds the cast inside the silhouette, so a step widens its blur without growing a rim. `[mech]`
- **Every step but the highest carries a far cast and a near contact cast.** At step 1 both layers sit at the same offset and separate by blur and spread instead, which holds a tight core inside a softer edge. At step 25 the far cast dominates and a contact layer adds nothing.
- **The dark half deepens the ink and widens the blur.** Alpha runs 0.4 to 0.7 against the light half's 0.1 to 0.25. A cast at light-half alpha vanishes on a canvas near black.
- **The ink is achromatic.** Black at an alpha darkens any surface without shifting its hue, so one scale serves every palette. `[mech]`
- **Density follows demand.** A step enters when a surface needs a height the scale does not hold, and nothing rounds out the run. `[human]`

## Constraints

| Property | Value |
|---|---|
| Ink | black at an alpha, chroma 0, on every layer |
| Light-half alpha | 0.1 to 0.25 |
| Dark-half alpha | 0.4 to 0.7 |
| Blur to y-offset ratio | 1.5× to 3× light, 2× to 3× dark |
| Smallest light-half y-offset ratio between neighbors | 2.5×, from `--rome-shadow-4` to `--rome-shadow-10` |
| Spread | 0 or negative |
| x-offset | 0 on every layer |

A chromatic ink turns a cast into a glow, and a glow carries a meaning elevation never does. A positive spread paints a rim that reads as a border. A neighbor pair under the 2.5× floor stops reading as two heights. A light-half alpha above 0.25 reads as a scrim.

## Forbidden usage

- A call site never writes an arbitrary shadow list. Every cast comes from a step, through the utility bound to it or through a semantic token aliasing a step. `[mech]`
- The scale carries no inset step. An inset shadow recesses a surface, and a recess is a fill or border decision, not an elevation. `[mech]`
- A focus or invalid state never renders through this scale. Those states are border and outline concerns. `[mech]`
- The hairline edge on a floating surface stays a border. A step never bundles a 1px edge layer into its list. `[mech]`
- A step never encodes a status, a brand, or an emphasis. Elevation carries height and nothing else. `[mech]`
- A component never derives a cast by arithmetic on a step, and never stacks two steps on one surface. `[mech]`
