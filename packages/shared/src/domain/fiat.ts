/** Fiat currencies an invoice may be denominated in. */
export interface FiatCurrencyConfig {
  readonly code: string;
  readonly displayName: string;
  /** ISO 4217 minor unit count. Money for this currency is held at this scale. */
  readonly decimals: number;
}

export const FIAT_CURRENCIES: Readonly<Record<string, FiatCurrencyConfig>> = Object.freeze({
  USD: { code: 'USD', displayName: 'US Dollar', decimals: 2 },
  EUR: { code: 'EUR', displayName: 'Euro', decimals: 2 },
  GBP: { code: 'GBP', displayName: 'Pound Sterling', decimals: 2 },
  SGD: { code: 'SGD', displayName: 'Singapore Dollar', decimals: 2 },
  IDR: { code: 'IDR', displayName: 'Indonesian Rupiah', decimals: 2 },
  JPY: { code: 'JPY', displayName: 'Japanese Yen', decimals: 0 },
});

export function findFiatCurrency(code: string): FiatCurrencyConfig | null {
  return FIAT_CURRENCIES[code.toUpperCase()] ?? null;
}

export function requireFiatCurrency(code: string): FiatCurrencyConfig {
  const found = findFiatCurrency(code);
  if (!found) throw new Error(`unsupported currency: ${code}`);
  return found;
}

export function isFiatCurrency(code: string): boolean {
  return findFiatCurrency(code) !== null;
}
