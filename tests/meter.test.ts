// The delta counters behind the plugin's metrics, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { add, collect, newMeter } from '../hooks/meter.ts'

const cost = (value: number, atMs: number, model = 'claude-haiku-5-5') => ({ name: 'claude_code.cost.usage', value, attributes: { model }, atMs })

describe('collect', () => {
  test('one point per series, summed, from its first measurement', () => {
    const m = newMeter()
    add(m, cost(0.25, 100))
    add(m, cost(0.5, 200))
    add(m, cost(1, 300, 'claude-opus-5-5'))
    expect(collect(m, 1_000)).toEqual([
      { name: 'claude_code.cost.usage', startMs: 100, timeMs: 1_000, value: 0.75, attributes: { model: 'claude-haiku-5-5' } },
      { name: 'claude_code.cost.usage', startMs: 300, timeMs: 1_000, value: 1, attributes: { model: 'claude-opus-5-5' } },
    ])
  })

  test('a series sent last time starts at that collection; a new one at its first measurement; an idle one is not sent', () => {
    const m = newMeter()
    add(m, cost(1, 100))
    add(m, cost(1, 150, 'claude-opus-5-5'))
    collect(m, 1_000)
    add(m, cost(2, 1_500))
    add(m, { name: 'claude_code.commit.count', value: 1, attributes: {}, atMs: 1_700 })
    expect(collect(m, 2_000)).toEqual([
      { name: 'claude_code.cost.usage', startMs: 1_000, timeMs: 2_000, value: 2, attributes: { model: 'claude-haiku-5-5' } },
      { name: 'claude_code.commit.count', startMs: 1_700, timeMs: 2_000, value: 1, attributes: {} },
    ])
    expect(collect(m, 3_000)).toEqual([])
    add(m, cost(4, 3_500))
    expect(collect(m, 4_000)[0]!.startMs).toBe(3_500)
  })

  test('attributes in any order are one series; a zero counts; a negative or a non-number does not', () => {
    const m = newMeter()
    add(m, { name: 'x', value: 1, attributes: { a: '1', b: '2' }, atMs: 1 })
    add(m, { name: 'x', value: 0, attributes: { b: '2', a: '1' }, atMs: 2 })
    add(m, { name: 'x', value: -1, attributes: { a: '1', b: '2' }, atMs: 3 })
    add(m, { name: 'x', value: Number.NaN, attributes: { a: '1', b: '2' }, atMs: 4 })
    add(m, { name: 'y', value: 0, attributes: {}, atMs: 5 })
    expect(collect(m, 10).map(p => [p.name, p.value])).toEqual([['x', 1], ['y', 0]])
  })
})
