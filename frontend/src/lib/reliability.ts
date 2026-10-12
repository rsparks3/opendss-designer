/** The reliability study on the drawing: which protection section an
 *  element is in, the colour that section wears, and the legend's wording.
 *  The numbers themselves come from the engine (core/reliability.py). */
import type { ReliabilityResult, ReliabilitySection } from '../types/circuit'
import type { LegendEntry } from './exportDiagram'

/** Categorical colours for sections, distinct in print, on a light and a
 *  dark canvas, and to most colour-blind readers; they cycle past eight. */
export const SECTION_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2']

/** Elements between a meter and the first protective device: in no
 *  section, and counted for nothing by the engine. */
export const UNSECTIONED_COLOR = '#9e9e9e'

export function sectionColor(result: ReliabilityResult, sectionId: string | null | undefined): string {
  if (!sectionId) return UNSECTIONED_COLOR
  const i = result.sections.findIndex((s) => s.id === sectionId)
  return i < 0 ? UNSECTIONED_COLOR : SECTION_COLORS[i % SECTION_COLORS.length]
}

/** The study's entry for a diagram element, by node or edge id. */
export function reliabilityOf(result: ReliabilityResult | null, id: string) {
  if (!result?.converged) return null
  for (const [name, el] of Object.entries(result.elements)) {
    if (el.id === id) return { name, data: el }
  }
  return null
}

/** The section an element heads, if it heads one. */
export function sectionHeadedBy(result: ReliabilityResult | null, id: string): ReliabilitySection | null {
  return result?.sections.find((s) => s.headId === id) ?? null
}

const f = (v: number | null | undefined, digits: number) => (v == null ? '—' : v.toFixed(digits))

/** "SAIFI 0.19 · SAIDI 0.65 h · CAIDI 3.45 h", for a legend or a status line. */
export function indicesLine(r: Pick<ReliabilityResult, 'saifi' | 'saidi' | 'caidi'>): string {
  return `SAIFI ${f(r.saifi, 3)} · SAIDI ${f(r.saidi, 3)} h · CAIDI ${f(r.caidi, 2)} h`
}

/** What a section is called in a legend or a table: its head device. */
export function sectionLabel(s: ReliabilitySection, nameOf: (id: string | null, fallback: string) => string): string {
  return nameOf(s.headId, s.head)
}

/** Legend rows for the reliability overlay: one per section, in the
 *  section's colour, plus the grey of what no device protects. */
export function reliabilityLegend(
  result: ReliabilityResult | null,
  nameOf: (id: string | null, fallback: string) => string,
): LegendEntry[] {
  if (!result?.converged) return []
  const rows = result.sections.map((s, i) => ({
    label: `${sectionLabel(s, nameOf)} · ${s.totalCustomers} cust · ${s.lambda.toFixed(3)} /yr`,
    color: SECTION_COLORS[i % SECTION_COLORS.length],
  }))
  if (result.unsectioned.count) rows.push({ label: 'no protective device upstream', color: UNSECTIONED_COLOR })
  return rows
}
