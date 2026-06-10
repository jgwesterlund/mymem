import { describe, expect, it } from 'vitest'
import { selectProbeIndices, similarityFromCosineDistance } from '../src/main/search/relatedMath'

describe('similarityFromCosineDistance', () => {
  // chunks_vec is declared distance_metric=cosine → distance = 1 - cos θ.
  it('maps cosine distance to similarity as the straight complement', () => {
    expect(similarityFromCosineDistance(0)).toBe(1) // identical direction
    expect(similarityFromCosineDistance(1)).toBe(0) // orthogonal
    expect(similarityFromCosineDistance(2)).toBe(-1) // opposite
    expect(similarityFromCosineDistance(0.55)).toBeCloseTo(0.45)
  })
})

describe('selectProbeIndices', () => {
  it('takes every chunk when n <= max', () => {
    expect(selectProbeIndices(1, 8)).toEqual([0])
    expect(selectProbeIndices(8, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('strides by ceil(n/max) when n > max', () => {
    expect(selectProbeIndices(9, 8)).toEqual([0, 2, 4, 6, 8]) // stride 2
    expect(selectProbeIndices(16, 8)).toEqual([0, 2, 4, 6, 8, 10, 12, 14])
    expect(selectProbeIndices(17, 8)).toEqual([0, 3, 6, 9, 12, 15]) // stride 3
  })

  it('never exceeds max probes', () => {
    for (let n = 1; n <= 200; n++) {
      const probes = selectProbeIndices(n, 8)
      expect(probes.length).toBeLessThanOrEqual(8)
      expect(probes[0]).toBe(0)
      expect(probes.every((i) => i < n)).toBe(true)
    }
  })

  it('handles empty and degenerate inputs', () => {
    expect(selectProbeIndices(0, 8)).toEqual([])
    expect(selectProbeIndices(-1, 8)).toEqual([])
    expect(selectProbeIndices(5, 0)).toEqual([])
  })
})
