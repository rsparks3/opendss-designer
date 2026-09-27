// Lay out a circuit JSON file the way the Import button does, from the
// command line. scripts/make_ieee_samples.py bundles this with esbuild and
// runs `node layout.mjs in.json out.json` to bake positions into the shipped
// samples, which load without any layout pass.
import { readFileSync, writeFileSync } from 'node:fs'
import { autoLayout } from '../src/lib/layout'
import type { CircuitJSON } from '../src/types/circuit'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: node scripts/layout-circuit.ts in.json out.json')
  process.exit(2)
}
const circuit = JSON.parse(readFileSync(input, 'utf-8')) as CircuitJSON
autoLayout(circuit)
writeFileSync(output, JSON.stringify(circuit, null, 1) + '\n')
