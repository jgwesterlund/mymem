/** Pure helpers for relatedService — unit-tested under plain Node. */

/**
 * chunks_vec is declared with distance_metric=cosine, so KNN distance is cosine
 * distance (1 - cos θ, range [0, 2] for arbitrary vectors). Similarity is the
 * straight complement — no L2 conversion needed.
 */
export function similarityFromCosineDistance(distance: number): number {
  return 1 - distance
}

/**
 * Probe selection for multi-query KNN: up to `max` chunk indices, every
 * ceil(n/max)-th — spreads probes across the whole note instead of centroiding
 * (multi-topic notes would wash out).
 */
export function selectProbeIndices(n: number, max: number): number[] {
  if (n <= 0 || max <= 0) return []
  const stride = Math.ceil(n / max)
  const out: number[] = []
  for (let i = 0; i < n; i += stride) out.push(i)
  return out
}
