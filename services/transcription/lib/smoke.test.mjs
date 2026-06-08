import { describe, it, expect } from 'vitest'

describe('backend test harness', () => {
  it('runs in node environment', () => {
    expect(typeof process.versions.node).toBe('string')
  })
})
