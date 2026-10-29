// The price that a quote takes from the readings of a market: the lower of the newest reading and
// the mean of a window, so that a price pushed up for a moment buys no extra credit. THKR
// (credit/token-price.ts) and the privacy coins (credit/coin-price.ts) share it, each with a window
// of its own.
import type { PriceSample } from './ledger.js';

export interface PriceWindow {
  /** The time over which a quote takes the mean of the price. */
  readonly windowMs: number;
  /** The fewest readings in that time for a quote. */
  readonly minSamples: number;
  /** The newest reading must be younger than this, or the price counts as unknown. */
  readonly maxSampleAgeMs: number;
}

/**
 * The smallest units that one dollar buys in a quote: the more of the newest reading and the mean
 * of the window, which is the lower price of the two. Null when the readings are too few or too
 * old.
 */
export function windowedUnitsPerUsd(
  samples: readonly PriceSample[],
  now: number,
  window: PriceWindow,
): bigint | null {
  const recent = samples.filter((sample) => sample.at > now - window.windowMs && sample.at <= now);
  const newest = recent.reduce<PriceSample | null>(
    (latest, sample) => (latest === null || sample.at > latest.at ? sample : latest),
    null,
  );
  if (newest === null || recent.length < window.minSamples) return null;
  if (now - newest.at > window.maxSampleAgeMs) return null;
  const mean = recent.reduce((sum, sample) => sum + sample.unitsPerUsd, 0n) / BigInt(recent.length);
  return newest.unitsPerUsd > mean ? newest.unitsPerUsd : mean;
}
