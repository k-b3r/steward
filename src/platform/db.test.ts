import { describe, expect, it, vi } from 'vitest'

import { createPool } from './db'

const URL = 'postgres://postgres:lab@127.0.0.1:1/none'

describe('createPool', () => {
  it('reports a dropped connection instead of crashing the process', () => {
    // An idle pg client that loses its server emits 'error' on the pool. Node treats an unhandled
    // 'error' event as a crash, which is how a Postgres restart used to kill the worker.
    const onError = vi.fn()
    const pool = createPool(URL, onError)

    pool.emit('error', new Error('terminating connection due to administrator command'))

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('terminating') }))
  })

  it('always has a listener, so an error can never be unhandled', () => {
    expect(createPool(URL).listenerCount('error')).toBeGreaterThan(0)
  })

  it('passes a non-Error value through as a message', () => {
    const onError = vi.fn()
    const pool = createPool(URL, onError)

    pool.emit('error', 'boom')

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  })
})
