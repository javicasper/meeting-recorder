import { describe, it, expect } from 'vitest'
import { createQueue } from './queue.mjs'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createQueue', () => {
  it('never runs more tasks at once than the concurrency limit', async () => {
    const queue = createQueue({ concurrency: 2 })
    let active = 0
    let peak = 0
    const gates = [deferred(), deferred(), deferred(), deferred()]

    const runs = gates.map((gate, i) =>
      queue.enqueue(async () => {
        active += 1
        peak = Math.max(peak, active)
        await gate.promise
        active -= 1
        return i
      })
    )

    await tick()
    expect(active).toBe(2)

    gates[0].resolve()
    await tick()
    expect(active).toBe(2) // third task slots in

    gates.forEach((g) => g.resolve())
    const results = await Promise.all(runs)

    expect(peak).toBe(2)
    expect(results).toEqual([0, 1, 2, 3])
  })

  it('isolates a failing task without blocking the rest', async () => {
    const queue = createQueue({ concurrency: 1 })

    const failing = queue.enqueue(async () => {
      throw new Error('boom')
    })
    const ok = queue.enqueue(async () => 'fine')

    await expect(failing).rejects.toThrow('boom')
    await expect(ok).resolves.toBe('fine')
  })

  it('reports active and pending counts', async () => {
    const queue = createQueue({ concurrency: 1 })
    const gate = deferred()

    queue.enqueue(async () => {
      await gate.promise
    })
    const second = queue.enqueue(async () => 'second')

    await tick()
    expect(queue.stats()).toEqual({ active: 1, pending: 1 })

    gate.resolve()
    await second
    await tick()
    expect(queue.stats()).toEqual({ active: 0, pending: 0 })
  })

  it('defaults to a concurrency of at least 1', async () => {
    const queue = createQueue()
    await expect(queue.enqueue(async () => 7)).resolves.toBe(7)
  })
})
