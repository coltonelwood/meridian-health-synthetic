import { Money, formatCurrency, centsToDecimal, decimalToCents, calculateTax, adjustAmount } from '../src/money';

describe('Money class', () => {
  describe('construction', () => {
    it('should create from integer cents', () => {
      const m = new Money(1050);
      expect(m.cents).toBe(1050);
      expect(m.dollars).toBe(10.50);
    });

    it('should reject non-integer cents', () => {
      expect(() => new Money(10.5)).toThrow('integer cents');
    });

    it('should create from decimal', () => {
      const m = Money.fromDecimal(10.50);
      expect(m.cents).toBe(1050);
    });

    it('should handle floating-point precision in fromDecimal', () => {
      // The classic 0.1 + 0.2 problem
      const m = Money.fromDecimal(0.1 + 0.2);
      expect(m.cents).toBe(30); // Should be 30 cents, not 30.000000000000004
    });

    it('should create zero', () => {
      const m = Money.zero();
      expect(m.cents).toBe(0);
      expect(m.isZero()).toBe(true);
    });
  });

  describe('arithmetic', () => {
    it('should add two amounts', () => {
      const a = new Money(1050);
      const b = new Money(250);
      expect(a.add(b).cents).toBe(1300);
    });

    it('should subtract amounts', () => {
      const a = new Money(1050);
      const b = new Money(250);
      expect(a.subtract(b).cents).toBe(800);
    });

    it('should handle negative results from subtraction', () => {
      const a = new Money(250);
      const b = new Money(1050);
      expect(a.subtract(b).cents).toBe(-800);
      expect(a.subtract(b).isNegative()).toBe(true);
    });

    it('should multiply by a factor', () => {
      const m = new Money(100); // $1.00
      expect(m.multiply(3).cents).toBe(300);
    });

    it('should round correctly when multiplying', () => {
      const m = new Money(100); // $1.00
      expect(m.multiply(0.065).cents).toBe(7); // 6.5 cents rounds to 7
    });

    it('should divide amounts', () => {
      const m = new Money(1000);
      expect(m.divide(3).cents).toBe(333);
    });

    it('should throw on divide by zero', () => {
      expect(() => new Money(100).divide(0)).toThrow('Cannot divide by zero');
    });
  });

  describe('comparison', () => {
    it('should compare greater than', () => {
      expect(new Money(200).isGreaterThan(new Money(100))).toBe(true);
      expect(new Money(100).isGreaterThan(new Money(200))).toBe(false);
    });

    it('should compare less than', () => {
      expect(new Money(100).isLessThan(new Money(200))).toBe(true);
    });

    it('should check equality', () => {
      expect(new Money(100).equals(new Money(100))).toBe(true);
      expect(new Money(100).equals(new Money(200))).toBe(false);
    });
  });

  describe('formatting', () => {
    it('should format positive amounts', () => {
      expect(new Money(123456).format()).toBe('$1,234.56');
    });

    it('should format negative amounts', () => {
      expect(new Money(-123456).format()).toBe('-$1,234.56');
    });

    it('should format zero', () => {
      expect(Money.zero().format()).toBe('$0.00');
    });

    it('should format small amounts', () => {
      expect(new Money(1).format()).toBe('$0.01');
    });

    it('should format using static method', () => {
      expect(Money.format(5000_00)).toBe('$5,000.00');
    });
  });

  describe('allocate', () => {
    it('should split evenly when possible', () => {
      const parts = new Money(300).allocate(3);
      expect(parts.map(p => p.cents)).toEqual([100, 100, 100]);
    });

    it('should distribute remainder to first recipients', () => {
      const parts = new Money(1000).allocate(3);
      // 1000 / 3 = 333 remainder 1
      expect(parts.map(p => p.cents)).toEqual([334, 333, 333]);
      // Total should equal original
      expect(parts.reduce((sum, p) => sum + p.cents, 0)).toBe(1000);
    });

    it('should handle allocation of $10.00 into 3 parts', () => {
      const parts = new Money(1000).allocate(3);
      const total = parts.reduce((sum, p) => sum + p.cents, 0);
      expect(total).toBe(1000); // No money lost
    });

    it('should throw for invalid parts', () => {
      expect(() => new Money(100).allocate(0)).toThrow('positive integer');
      expect(() => new Money(100).allocate(-1)).toThrow('positive integer');
    });
  });

  describe('allocateByWeights', () => {
    it('should allocate by proportional weights', () => {
      const parts = new Money(10000).allocateByWeights([3, 7]);
      expect(parts[0].cents).toBe(3000);
      expect(parts[1].cents).toBe(7000);
    });

    it('should handle uneven allocations', () => {
      const parts = new Money(100).allocateByWeights([1, 1, 1]);
      const total = parts.reduce((sum, p) => sum + p.cents, 0);
      expect(total).toBe(100); // Last part gets remainder
    });

    it('should throw for empty weights', () => {
      expect(() => new Money(100).allocateByWeights([])).toThrow('empty');
    });
  });

  describe('toJSON', () => {
    it('should serialize as cents', () => {
      const m = new Money(1050);
      expect(JSON.stringify({ amount: m })).toBe('{"amount":1050}');
    });
  });
});

describe('standalone functions', () => {
  it('centsToDecimal should convert correctly', () => {
    expect(centsToDecimal(1050)).toBe(10.50);
    expect(centsToDecimal(0)).toBe(0);
    expect(centsToDecimal(-500)).toBe(-5);
  });

  it('decimalToCents should convert correctly', () => {
    expect(decimalToCents(10.50)).toBe(1050);
    expect(decimalToCents(0)).toBe(0);
    expect(decimalToCents(0.1 + 0.2)).toBe(30); // Handles floating-point
  });

  it('formatCurrency should format cents as dollars', () => {
    expect(formatCurrency(12345)).toBe('$123.45');
  });

  it('calculateTax should compute correctly', () => {
    expect(calculateTax(10000, 0.065)).toBe(650); // 6.5% of $100
  });

  it('adjustAmount should subtract by default', () => {
    expect(adjustAmount(10000, 2000)).toBe(8000);
  });

  it('adjustAmount should add when specified', () => {
    expect(adjustAmount(10000, 2000, 'add')).toBe(12000);
  });
});
