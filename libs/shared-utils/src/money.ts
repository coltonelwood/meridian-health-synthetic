/**
 * Money/currency utilities for Meridian Health.
 *
 * CRITICAL: All monetary values in the system are stored as integer cents.
 * Never use floating-point for money. The classic floating-point issue
 * (0.1 + 0.2 !== 0.3) has caused real billing discrepancies in healthcare.
 *
 * We learned this the hard way in Q2 2024 when a rounding error in the
 * payment posting logic caused $0.01 discrepancies on 2,300 patient
 * statements. Small amounts, but it triggered compliance questions and
 * took 3 weeks to reconcile.
 */

/**
 * Money class for safe monetary arithmetic.
 * All amounts are stored as integer cents.
 */
export class Money {
  private readonly _cents: number;

  constructor(cents: number) {
    if (!Number.isInteger(cents)) {
      throw new Error(
        `Money must be initialized with integer cents, got ${cents}. ` +
        `Use Money.fromDecimal() for dollar amounts.`
      );
    }
    this._cents = cents;
  }

  get cents(): number {
    return this._cents;
  }

  get dollars(): number {
    return this._cents / 100;
  }

  /** Create from a dollar amount (e.g., 10.50 -> 1050 cents) */
  static fromDecimal(amount: number): Money {
    // Round to handle floating-point precision issues
    return new Money(Math.round(amount * 100));
  }

  /** Create from cents */
  static fromCents(cents: number): Money {
    return new Money(cents);
  }

  /** Zero amount */
  static zero(): Money {
    return new Money(0);
  }

  /** Add two Money values */
  add(other: Money): Money {
    return new Money(this._cents + other._cents);
  }

  /** Subtract a Money value */
  subtract(other: Money): Money {
    return new Money(this._cents - other._cents);
  }

  /** Multiply by a factor (e.g., quantity) */
  multiply(factor: number): Money {
    return new Money(Math.round(this._cents * factor));
  }

  /** Divide by a divisor */
  divide(divisor: number): Money {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return new Money(Math.round(this._cents / divisor));
  }

  /** Check if this amount is greater than another */
  isGreaterThan(other: Money): boolean {
    return this._cents > other._cents;
  }

  /** Check if this amount is less than another */
  isLessThan(other: Money): boolean {
    return this._cents < other._cents;
  }

  /** Check if amounts are equal */
  equals(other: Money): boolean {
    return this._cents === other._cents;
  }

  /** Check if amount is zero */
  isZero(): boolean {
    return this._cents === 0;
  }

  /** Check if amount is negative */
  isNegative(): boolean {
    return this._cents < 0;
  }

  /** Get the absolute value */
  abs(): Money {
    return new Money(Math.abs(this._cents));
  }

  /** Negate the amount */
  negate(): Money {
    return new Money(-this._cents);
  }

  /**
   * Format as a US dollar string.
   * Examples: "$1,234.56", "-$10.00", "$0.01"
   */
  format(): string {
    return Money.format(this._cents);
  }

  /**
   * Static format helper that works with raw cent values.
   * This is the most commonly used method since many parts of the system
   * pass around raw cents rather than Money objects (tech debt).
   */
  static format(cents: number): string {
    const isNegative = cents < 0;
    const absCents = Math.abs(cents);
    const dollars = Math.floor(absCents / 100);
    const remainingCents = absCents % 100;

    const formatted = `$${dollars.toLocaleString('en-US')}.${remainingCents.toString().padStart(2, '0')}`;
    return isNegative ? `-${formatted}` : formatted;
  }

  toString(): string {
    return this.format();
  }

  toJSON(): number {
    return this._cents;
  }

  /**
   * Allocate an amount across N recipients, handling remainder.
   * Example: $10.00 / 3 = [$3.34, $3.33, $3.33]
   *
   * This is used for splitting payments across multiple service lines
   * or distributing adjustments proportionally.
   */
  allocate(parts: number): Money[] {
    if (parts <= 0 || !Number.isInteger(parts)) {
      throw new Error('Parts must be a positive integer');
    }

    const quotient = Math.floor(this._cents / parts);
    const remainder = this._cents % parts;

    const result: Money[] = [];
    for (let i = 0; i < parts; i++) {
      // Distribute remainder to the first N recipients
      result.push(new Money(quotient + (i < remainder ? 1 : 0)));
    }

    return result;
  }

  /**
   * Allocate proportionally by weights.
   * Example: $100 allocated by weights [3, 7] = [$30, $70]
   *
   * Used for pro-rata adjustments on multi-line claims.
   */
  allocateByWeights(weights: number[]): Money[] {
    if (weights.length === 0) {
      throw new Error('Weights array cannot be empty');
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight === 0) {
      throw new Error('Total weight cannot be zero');
    }

    const result: Money[] = [];
    let remaining = this._cents;

    for (let i = 0; i < weights.length; i++) {
      if (i === weights.length - 1) {
        // Last item gets the remainder to ensure total is exact
        result.push(new Money(remaining));
      } else {
        const amount = Math.round((this._cents * weights[i]) / totalWeight);
        result.push(new Money(amount));
        remaining -= amount;
      }
    }

    return result;
  }
}

// --- Standalone utility functions (for code that doesn't use Money objects) ---

/** Convert cents to decimal dollars */
export function centsToDecimal(cents: number): number {
  return cents / 100;
}

/** Convert decimal dollars to cents */
export function decimalToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Format cents as a dollar string */
export function formatCurrency(cents: number): string {
  return Money.format(cents);
}

/**
 * Calculate tax on an amount.
 * Rate should be a decimal (e.g., 0.065 for 6.5% tax).
 *
 * Note: Healthcare services are generally exempt from sales tax,
 * but some ancillary products (e.g., DME, cosmetic procedures)
 * may be taxable depending on the state. This is used by the
 * billing module for those edge cases.
 */
export function calculateTax(amountCents: number, rate: number): number {
  return Math.round(amountCents * rate);
}

/**
 * Apply an adjustment to an amount.
 * Adjustments can be positive (increase) or negative (decrease).
 *
 * Healthcare adjustments include:
 * - Contractual adjustments (difference between billed and allowed amount)
 * - Write-offs (bad debt, charity care)
 * - Prompt pay discounts
 * - Multi-service discounts
 */
export function adjustAmount(
  originalCents: number,
  adjustmentCents: number,
  type: 'add' | 'subtract' = 'subtract'
): number {
  return type === 'add'
    ? originalCents + adjustmentCents
    : originalCents - adjustmentCents;
}
