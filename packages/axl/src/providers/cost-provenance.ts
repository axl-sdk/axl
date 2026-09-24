/**
 * Helpers for stamping `ProviderResponse.costProvenance` /
 * `StreamChunk(done).costProvenance`.
 *
 * The distinction that matters downstream is whether the USD figure came from
 * the vendor (authoritative, reconcilable against an invoice) or from an Axl
 * price table (an estimate that goes stale when a vendor reprices). Accounting
 * reports the split; a cost with no stamp is recorded as `'adapter_reported'`.
 */

import type { ProviderResponse } from '../types.js';

type Provenance = NonNullable<ProviderResponse['costProvenance']>;

/** Stamp an Axl/adapter price-table estimate. `undefined` cost stays unstamped. */
export function tableEstimate(cost: number | undefined): Provenance | undefined {
  return cost === undefined ? undefined : 'price_table_estimate';
}

/** Stamp a figure the vendor itself reported. `undefined` cost stays unstamped. */
export function providerReported(cost: number | undefined): Provenance | undefined {
  return cost === undefined ? undefined : 'provider_reported';
}
