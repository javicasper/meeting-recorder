/**
 * Minimal in-process job queue with a concurrency cap.
 * enqueue(fn) returns a promise that settles with fn's result; at most
 * `concurrency` jobs run at any moment, the rest wait their turn.
 */
export const createQueue = ({ concurrency = 1 } = {}) => {
  const limit = Math.max(1, Number(concurrency) || 1)
  const pending = []
  let active = 0

  const drain = () => {
    while (active < limit && pending.length > 0) {
      const { fn, resolve, reject } = pending.shift()
      active += 1
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active -= 1
          drain()
        })
    }
  }

  const enqueue = (fn) =>
    new Promise((resolve, reject) => {
      pending.push({ fn, resolve, reject })
      drain()
    })

  const stats = () => ({ active, pending: pending.length })

  return { enqueue, stats }
}
