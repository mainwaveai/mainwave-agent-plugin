// The plugin's catalog (hooks/catalog.ts) against Mainwave's, of which hooks/data-points.json is a copy: the same data points, in the
// same order, field by field, and the same owner for every attribute, `tool_parameters` key, `tool.output` key, metric and row the
// plugin makes. Mainwave's catalog is the source: where they differ, catalog.ts changes. Not compared: each data point's default, as
// the plugin's `DEFAULTS` are its own, for a session with no organization settings, and Mainwave's are an organization's.

import { describe, expect, test } from 'claude-code/testing'

import { ATTRIBUTE_OWNERS, CATALOG, KEY_PREFIXES, METRIC_OWNERS, OUTPUT_OWNERS, OWN_ROWS, PARAMETER_OWNERS, TOOL_OUTPUT_EVENT, type DataPointId } from '../hooks/catalog.ts'
import vendored from './fixtures/data-points.ts'

type Attributes = { keys: string[]; records?: string[]; redact?: boolean }
type Entry = {
  id: string; class: string; required?: boolean; default?: string; switch?: string; holds?: string[]; needs?: string; description: string; example: string
  attributes?: Attributes[]; parameters?: string[]; output_keys?: string[]; own_rows?: string[]; key_prefixes?: string[]; metrics?: string[]
}
const json = vendored as unknown as { catalog_version: number; tool_output_event: string; data_points: Entry[] }

/** The fields this test reads; a field Mainwave's catalog adds fails the last test until it is compared too. */
const FIELDS = ['id', 'class', 'required', 'default', 'switch', 'holds', 'needs', 'description', 'example', 'attributes', 'parameters', 'output_keys', 'own_rows', 'key_prefixes', 'metrics']

/** Each owned key as one line: its key, the records it is limited to, and whether it is redacted. */
const ownership = (entries: readonly { key: string; records?: readonly string[]; redact?: boolean }[]) =>
  entries.map(o => `${o.key}${o.records ? ` in ${[...o.records].sort().join(',')}` : ''}${o.redact ? ' redact' : ''}`).sort()
const ownedBy = (table: Readonly<Record<string, DataPointId>>, id: string) => Object.keys(table).filter(k => table[k] === id).sort()
const byId = new Map(json.data_points.map(d => [d.id, d]))

describe('the catalog, against Mainwave\'s', () => {
  test('the same data points, in the same order', () => {
    expect(CATALOG.map(d => d.id)).toEqual(json.data_points.map(d => d.id) as DataPointId[])
  })

  test('each data point: its class, whether it is required, its switch, what it holds and needs, its description and example', () => {
    for (const d of CATALOG) {
      const j = byId.get(d.id)!
      expect({ id: d.id, class: d.class, required: d.required ?? false, switch: d.switch, holds: d.holds, needs: d.needs, description: d.description, example: d.example })
        .toEqual({ id: j.id, class: j.class, required: j.required ?? false, switch: j.switch, holds: j.holds, needs: j.needs, description: j.description, example: j.example })
    }
  })

  test('each attribute has the same owner, limited to the same records, redacted alike', () => {
    for (const d of CATALOG) {
      const mine = ownership(ATTRIBUTE_OWNERS.filter(o => o.id === d.id).map(o => ({ key: o.key, records: o.in, redact: o.redact })))
      const theirs = ownership((byId.get(d.id)!.attributes ?? []).flatMap(a => a.keys.map(key => ({ key, records: a.records, redact: a.redact }))))
      expect({ id: d.id, attributes: mine }).toEqual({ id: d.id, attributes: theirs })
    }
  })

  test('each tool_parameters key, tool.output key, key prefix, metric and own row has the same owner', () => {
    expect(TOOL_OUTPUT_EVENT).toBe(json.tool_output_event)
    for (const d of CATALOG) {
      const j = byId.get(d.id)!
      expect({ id: d.id, parameters: ownedBy(PARAMETER_OWNERS, d.id), output: ownedBy(OUTPUT_OWNERS, d.id), prefixes: ownedBy(KEY_PREFIXES, d.id), metrics: ownedBy(METRIC_OWNERS, d.id), rows: ownedBy(OWN_ROWS, d.id) })
        .toEqual({ id: d.id, parameters: [...(j.parameters ?? [])].sort(), output: [...(j.output_keys ?? [])].sort(), prefixes: [...(j.key_prefixes ?? [])].sort(), metrics: [...(j.metrics ?? [])].sort(), rows: [...(j.own_rows ?? [])].sort() })
    }
  })

  test('the copy holds no field this test does not compare', () => {
    expect(json.catalog_version).toBe(1)
    for (const d of json.data_points) expect(Object.keys(d).filter(k => !FIELDS.includes(k))).toEqual([])
  })
})
