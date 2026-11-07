import { describe, expect, it } from 'vitest'

import {
  assertLimits,
  decideSpawn,
  findToReap,
  reapAll,
  recordEvent,
  type SubagentLimits,
  type SubagentRecord,
} from './subagent-policy'

const T0 = new Date('2026-01-01T00:00:00.000Z')
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)

const LIMITS: SubagentLimits = {
  maxConcurrent: 2,
  maxTotal: 5,
  maxDepth: 1,
  maxRuntimeMs: 600_000, // 10 min
  maxSilentMs: 120_000, // 2 min
  toolTimeoutMs: 300_000, // 5 min
}

function agent(id: string, overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return { id, depth: 1, startedAt: T0, lastActivityAt: T0, openTools: {}, ...overrides }
}

describe('decideSpawn', () => {
  const lead = { requesterDepth: 0, running: [] as SubagentRecord[], spawnedTotal: 0, limits: LIMITS }

  it('lets the lead agent start a sub-agent when nothing limits it', () => {
    expect(decideSpawn(lead)).toEqual({ allow: true })
  })

  it('lets the lead start another one-shot after the first one ended', () => {
    // A finished one-shot is no longer in `running`, but it still counts toward the total.
    expect(decideSpawn({ ...lead, running: [], spawnedTotal: 1 })).toEqual({ allow: true })
  })

  it('refuses a sub-agent that tries to start another one (depth)', () => {
    expect(decideSpawn({ ...lead, requesterDepth: 1 })).toEqual({ allow: false, reason: 'depth' })
  })

  it('refuses everyone when maxDepth is 0', () => {
    const noSub = { ...lead, limits: { ...LIMITS, maxDepth: 0 } }
    expect(decideSpawn(noSub)).toEqual({ allow: false, reason: 'depth' })
  })

  it('allows a deeper tree when maxDepth is 2, but not beyond', () => {
    const deep = { ...lead, limits: { ...LIMITS, maxDepth: 2 } }
    expect(decideSpawn({ ...deep, requesterDepth: 1 })).toEqual({ allow: true })
    expect(decideSpawn({ ...deep, requesterDepth: 2 })).toEqual({ allow: false, reason: 'depth' })
  })

  it('caps how many run at once, at exactly maxConcurrent', () => {
    expect(decideSpawn({ ...lead, running: [agent('a')] })).toEqual({ allow: true })
    expect(decideSpawn({ ...lead, running: [agent('a'), agent('b')] })).toEqual({ allow: false, reason: 'concurrent' })
  })

  it('caps how many are ever started, at exactly maxTotal', () => {
    expect(decideSpawn({ ...lead, spawnedTotal: 4 })).toEqual({ allow: true })
    expect(decideSpawn({ ...lead, spawnedTotal: 5 })).toEqual({ allow: false, reason: 'total' })
  })

  it('reports the permanent reasons before the one that clears by waiting', () => {
    const full = [agent('a'), agent('b')]
    // total beats concurrent: waiting will not help once the budget of spawns is gone.
    expect(decideSpawn({ ...lead, running: full, spawnedTotal: 5 })).toEqual({ allow: false, reason: 'total' })
    // depth beats both.
    expect(decideSpawn({ ...lead, requesterDepth: 1, running: full, spawnedTotal: 5 })).toEqual({
      allow: false,
      reason: 'depth',
    })
  })

  it('rejects invalid limits instead of guessing', () => {
    expect(() => decideSpawn({ ...lead, limits: { ...LIMITS, maxConcurrent: -1 } })).toThrow(RangeError)
  })
})

describe('assertLimits', () => {
  it('accepts the normal limits, and zero for the counts (0 means "none allowed")', () => {
    expect(() => assertLimits(LIMITS)).not.toThrow()
    expect(() => assertLimits({ ...LIMITS, maxDepth: 0, maxConcurrent: 0, maxTotal: 0 })).not.toThrow()
  })

  it.each(Object.keys(LIMITS) as (keyof SubagentLimits)[])('rejects a negative %s', (key) => {
    expect(() => assertLimits({ ...LIMITS, [key]: -1 })).toThrow(RangeError)
  })

  it.each(Object.keys(LIMITS) as (keyof SubagentLimits)[])('rejects a NaN %s', (key) => {
    expect(() => assertLimits({ ...LIMITS, [key]: Number.NaN })).toThrow(RangeError)
  })

  it.each(['maxConcurrent', 'maxTotal', 'maxDepth'] as const)('rejects a fractional %s', (key) => {
    expect(() => assertLimits({ ...LIMITS, [key]: 1.5 })).toThrow(RangeError)
  })

  it.each(['maxRuntimeMs', 'maxSilentMs', 'toolTimeoutMs'] as const)(
    'rejects a zero %s, which would stop every agent at birth',
    (key) => {
      expect(() => assertLimits({ ...LIMITS, [key]: 0 })).toThrow(RangeError)
    },
  )

  it.each(['maxSilentMs', 'maxConcurrent'] as const)('names the bad field in the message (%s)', (key) => {
    expect(() => assertLimits({ ...LIMITS, [key]: -5 })).toThrow(new RegExp(key))
  })
})

describe('recordEvent', () => {
  it('marks the time of any activity', () => {
    const next = recordEvent(agent('a'), { type: 'activity' }, at(30))
    expect(next.lastActivityAt).toEqual(at(30))
    expect(next.startedAt).toEqual(T0)
  })

  it('tracks a tool call from its start to its end', () => {
    const started = recordEvent(agent('a'), { type: 'tool_start', toolCallId: 't1' }, at(10))
    expect(started.openTools).toEqual({ t1: at(10) })

    const ended = recordEvent(started, { type: 'tool_end', toolCallId: 't1' }, at(20))
    expect(ended.openTools).toEqual({})
    expect(ended.lastActivityAt).toEqual(at(20))
  })

  it('tracks parallel tool calls separately', () => {
    let record = agent('a')
    record = recordEvent(record, { type: 'tool_start', toolCallId: 't1' }, at(10))
    record = recordEvent(record, { type: 'tool_start', toolCallId: 't2' }, at(15))
    record = recordEvent(record, { type: 'tool_end', toolCallId: 't1' }, at(20))
    expect(record.openTools).toEqual({ t2: at(15) })
  })

  it('ignores the end of a tool call it never saw, but still counts it as activity', () => {
    const next = recordEvent(agent('a'), { type: 'tool_end', toolCallId: 'ghost' }, at(5))
    expect(next.openTools).toEqual({})
    expect(next.lastActivityAt).toEqual(at(5))
  })

  it('never changes the record it was given', () => {
    const original = agent('a')
    recordEvent(original, { type: 'tool_start', toolCallId: 't1' }, at(10))
    expect(original.openTools).toEqual({})
    expect(original.lastActivityAt).toEqual(T0)
  })
})

describe('findToReap', () => {
  it('leaves healthy agents alone', () => {
    expect(findToReap([agent('a', { lastActivityAt: at(60) })], at(100), LIMITS)).toEqual([])
    expect(findToReap([], at(100), LIMITS)).toEqual([])
  })

  it('stops an agent that has run too long, at exactly maxRuntimeMs', () => {
    // Active right up to the limit, so only the runtime rule can fire.
    const busy = agent('a', { lastActivityAt: at(599) })
    expect(findToReap([busy], at(599.999), LIMITS)).toEqual([])
    expect(findToReap([busy], at(600), LIMITS)).toEqual([{ id: 'a', reason: 'max-runtime' }])
  })

  it('stops an agent that went silent, at exactly maxSilentMs', () => {
    const quiet = agent('a', { lastActivityAt: at(10) })
    expect(findToReap([quiet], at(129.999), LIMITS)).toEqual([])
    expect(findToReap([quiet], at(130), LIMITS)).toEqual([{ id: 'a', reason: 'silent' }])
  })

  it('does not call an agent silent while a tool call is running', () => {
    // 4 minutes without output, but a tool (say, the test suite) is still working.
    const waiting = agent('a', { lastActivityAt: at(10), openTools: { t1: at(10) } })
    expect(findToReap([waiting], at(250), LIMITS)).toEqual([])
  })

  it('stops an agent whose tool call never ends, at exactly toolTimeoutMs', () => {
    const stuck = agent('a', { lastActivityAt: at(10), openTools: { t1: at(10) } })
    expect(findToReap([stuck], at(309.999), LIMITS)).toEqual([])
    expect(findToReap([stuck], at(310), LIMITS)).toEqual([{ id: 'a', reason: 'tool-timeout' }])
  })

  it('judges parallel tool calls by the oldest one', () => {
    const stuck = agent('a', { lastActivityAt: at(290), openTools: { old: at(0), fresh: at(290) } })
    expect(findToReap([stuck], at(300), LIMITS)).toEqual([{ id: 'a', reason: 'tool-timeout' }])
  })

  it('finds the oldest tool call even when it is not the first one listed', () => {
    const stuck = agent('a', { lastActivityAt: at(290), openTools: { fresh: at(290), old: at(0) } })
    expect(findToReap([stuck], at(300), LIMITS)).toEqual([{ id: 'a', reason: 'tool-timeout' }])
  })

  it('reports one reason per agent: runtime first, then tool timeout, then silence', () => {
    const everything = agent('a', { startedAt: T0, lastActivityAt: T0, openTools: { t1: T0 } })
    expect(findToReap([everything], at(700), LIMITS)).toEqual([{ id: 'a', reason: 'max-runtime' }])

    const toolAndSilent = agent('b', { startedAt: at(500), lastActivityAt: at(500), openTools: { t1: at(500) } })
    expect(findToReap([toolAndSilent], at(900), { ...LIMITS, maxRuntimeMs: 10_000_000 })).toEqual([
      { id: 'b', reason: 'tool-timeout' },
    ])
  })

  it('returns only the offenders, in the order given', () => {
    const agents = [
      agent('ok-1', { lastActivityAt: at(190) }),
      agent('silent', { lastActivityAt: at(10) }),
      agent('ok-2', { lastActivityAt: at(195) }),
      agent('slow', { startedAt: at(-1000), lastActivityAt: at(199) }),
    ]
    expect(findToReap(agents, at(200), LIMITS)).toEqual([
      { id: 'silent', reason: 'silent' },
      { id: 'slow', reason: 'max-runtime' },
    ])
  })

  it('rejects invalid limits', () => {
    expect(() => findToReap([agent('a')], at(1), { ...LIMITS, maxSilentMs: -1 })).toThrow(RangeError)
  })
})

describe('reapAll', () => {
  it('stops every running agent when the job ends, whatever state it is in', () => {
    const agents = [agent('a'), agent('b', { openTools: { t1: at(1) } })]
    expect(reapAll(agents)).toEqual([
      { id: 'a', reason: 'job-ended' },
      { id: 'b', reason: 'job-ended' },
    ])
  })

  it('has nothing to do when nothing runs', () => {
    expect(reapAll([])).toEqual([])
  })
})
