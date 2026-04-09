import { calculatePatientResponsibility, estimatePatientCostShare } from '../src/services/billingService';

describe('calculatePatientResponsibility', () => {
  it('should return zeros for empty line items', () => {
    const result = calculatePatientResponsibility([], []);

    expect(result.subtotal_cents).toBe(0);
    expect(result.tax_cents).toBe(0);
    expect(result.total_adjustments_cents).toBe(0);
    expect(result.total_insurance_paid_cents).toBe(0);
    expect(result.patient_responsibility_cents).toBe(0);
  });

  it('should calculate simple patient responsibility', () => {
    const result = calculatePatientResponsibility([
      { unit_price_cents: 15000, quantity: 1 },
    ]);

    expect(result.subtotal_cents).toBe(15000);
    expect(result.patient_responsibility_cents).toBe(15000);
  });

  it('should handle insurance payments', () => {
    const result = calculatePatientResponsibility([
      {
        unit_price_cents: 25000, // $250 office visit
        quantity: 1,
        adjustment_cents: 10000, // $100 contractual adjustment
        insurance_paid_cents: 12000, // $120 insurance paid
      },
    ]);

    expect(result.subtotal_cents).toBe(25000);
    expect(result.total_adjustments_cents).toBe(10000);
    expect(result.total_insurance_paid_cents).toBe(12000);
    // Patient owes: 250 - 100 - 120 = $30
    expect(result.patient_responsibility_cents).toBe(3000);
  });

  it('should handle multiple line items', () => {
    const result = calculatePatientResponsibility([
      {
        unit_price_cents: 20000, // $200
        quantity: 1,
        adjustment_cents: 5000,
        insurance_paid_cents: 10000,
      },
      {
        unit_price_cents: 5000, // $50
        quantity: 2, // quantity 2 = $100
        adjustment_cents: 0,
        insurance_paid_cents: 8000,
      },
    ]);

    // Subtotal: 200 + 100 = $300
    expect(result.subtotal_cents).toBe(30000);
    // Adjustments: 50
    expect(result.total_adjustments_cents).toBe(5000);
    // Insurance: 100 + 80 = $180
    expect(result.total_insurance_paid_cents).toBe(18000);
    // Patient: 300 - 50 - 180 = $70
    expect(result.patient_responsibility_cents).toBe(7000);
  });

  it('should handle tax on non-medical services', () => {
    const result = calculatePatientResponsibility([
      {
        unit_price_cents: 50000, // $500 cosmetic procedure
        quantity: 1,
        tax_cents: 4125, // 8.25% tax
      },
    ]);

    expect(result.subtotal_cents).toBe(50000);
    expect(result.tax_cents).toBe(4125);
    expect(result.patient_responsibility_cents).toBe(54125); // $541.25
  });

  it('should calculate tax from rate when tax_cents not provided', () => {
    const result = calculatePatientResponsibility([
      {
        unit_price_cents: 10000,
        quantity: 1,
        adjustment_cents: 2000,
        tax_rate: 10, // 10% tax
      },
    ]);

    // Tax is calculated on (10000 - 2000) * 10% = $8
    expect(result.tax_cents).toBe(800);
    // Patient: 10000 - 2000 + 800 = $88
    expect(result.patient_responsibility_cents).toBe(8800);
  });

  it('should floor negative patient responsibility at zero', () => {
    const result = calculatePatientResponsibility([
      {
        unit_price_cents: 10000,
        quantity: 1,
        adjustment_cents: 3000,
        insurance_paid_cents: 9000, // insurance overpaid
      },
    ]);

    // Would be: 10000 - 3000 - 9000 = -2000
    // But we floor at 0
    expect(result.patient_responsibility_cents).toBe(0);
  });

  it('should apply invoice-level adjustments', () => {
    const result = calculatePatientResponsibility(
      [
        { unit_price_cents: 20000, quantity: 1 },
      ],
      [
        { type: 'prompt_pay', amount_cents: 2000 }, // $20 prompt pay discount
        { type: 'charity', amount_cents: 5000 }, // $50 charity care
      ]
    );

    // Patient: 200 - 20 - 50 = $130
    expect(result.patient_responsibility_cents).toBe(13000);
  });

  // This test documents the floating point precision issue that
  // motivated us to use Decimal.js
  it('should handle amounts that cause floating point issues', () => {
    const result = calculatePatientResponsibility([
      { unit_price_cents: 1999, quantity: 3 }, // 59.97
      { unit_price_cents: 3333, quantity: 1 }, // 33.33
    ]);

    // 5997 + 3333 = 9330 exactly
    expect(result.subtotal_cents).toBe(9330);
    expect(result.patient_responsibility_cents).toBe(9330);
  });

  it('should return correct line item details', () => {
    const result = calculatePatientResponsibility([
      {
        unit_price_cents: 15000,
        quantity: 1,
        adjustment_cents: 5000,
        insurance_paid_cents: 7000,
        tax_cents: 0,
      },
      {
        unit_price_cents: 8000,
        quantity: 1,
        adjustment_cents: 0,
        insurance_paid_cents: 6000,
        tax_cents: 200,
      },
    ]);

    expect(result.line_item_details).toHaveLength(2);

    // First line item: 150 - 50 - 70 = $30
    expect(result.line_item_details[0].patient_responsibility_cents).toBe(3000);

    // Second line item: 80 - 0 - 60 + 2 = $22
    expect(result.line_item_details[1].patient_responsibility_cents).toBe(2200);
  });
});

describe('estimatePatientCostShare', () => {
  it('should estimate copay for office visit', () => {
    const result = estimatePatientCostShare({
      service_type: 'office_visit_primary',
      charge_amount_cents: 25000,
      is_in_network: true,
      has_met_deductible: true,
    });

    expect(result.copay_cents).toBe(2500); // $25
    expect(result.coinsurance_percent).toBe(20);
    expect(result.deductible_applied_cents).toBe(0);
  });

  it('should apply deductible when not met', () => {
    const result = estimatePatientCostShare({
      service_type: 'office_visit_specialist',
      charge_amount_cents: 30000, // $300
      is_in_network: true,
      has_met_deductible: false,
      remaining_deductible_cents: 100000, // $1000 remaining
    });

    expect(result.copay_cents).toBe(5000); // $50 copay
    // After copay: $250 goes to deductible
    expect(result.deductible_applied_cents).toBe(25000);
  });

  it('should use higher coinsurance for out of network', () => {
    const result = estimatePatientCostShare({
      service_type: 'office_visit_specialist',
      charge_amount_cents: 30000,
      is_in_network: false,
      has_met_deductible: true,
    });

    expect(result.coinsurance_percent).toBe(40); // 40% out of network
  });

  it('should return zero for preventive care', () => {
    const result = estimatePatientCostShare({
      service_type: 'preventive',
      charge_amount_cents: 20000,
      is_in_network: true,
      has_met_deductible: true,
    });

    expect(result.copay_cents).toBe(0);
  });

  // TODO: test with deductible partially applied
  // TODO: test with out-of-pocket max reached
  // TODO: test family vs individual deductible
});
