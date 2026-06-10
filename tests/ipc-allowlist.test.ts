import { describe, expect, it } from 'vitest'
import {
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  type InvokeChannel,
  type PushChannel
} from '@shared/ipc'

// Type-level sync with the IPC maps, both directions:
// 1) the `satisfies readonly InvokeChannel[]` in ipc.ts rejects typos in the arrays,
// 2) the AssertNever lines below fail to compile if a map key is missing from its array.
type AssertNever<T extends never> = T
type _InvokeComplete = AssertNever<Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>>
type _PushComplete = AssertNever<Exclude<PushChannel, (typeof PUSH_CHANNELS)[number]>>

const CHANNEL_PATTERN = /^[a-z]+:[a-z-]+(:[a-z-]+)?$/i

describe('IPC channel allowlists', () => {
  it('invoke channels have no duplicates', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
  })

  it('push channels have no duplicates', () => {
    expect(new Set(PUSH_CHANNELS).size).toBe(PUSH_CHANNELS.length)
  })

  it('invoke and push channels do not overlap', () => {
    const push = new Set<string>(PUSH_CHANNELS)
    expect(INVOKE_CHANNELS.filter((c) => push.has(c))).toEqual([])
  })

  it('every channel follows the domain:action naming scheme', () => {
    for (const channel of [...INVOKE_CHANNELS, ...PUSH_CHANNELS]) {
      expect(channel, `channel ${channel}`).toMatch(CHANNEL_PATTERN)
    }
  })
})
