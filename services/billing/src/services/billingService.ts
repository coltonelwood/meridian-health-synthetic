import Decimal from 'decimal.js';
import { Pool } from 'pg';

// Configure Decimal.js for financial calculations
Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
});

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

interface LineItemInput {
  unit_price_cents: number;
  quantity?: number;
  adjustment_cents?: number;
  insurance_paid_cents?: number;
  tax_cents?: number;
  // tax rate as percentage (e.g., 8.25 for 8.25%)
  tax_rate?: number;
}

interface AdjustmentInput {
  type: string;
  amount_cents: number;
}

interface CalculationResult {
  subtotal_cents: number;
  tax_cents: number;
  total_adjustments_cents: number;
  total_insurance_paid_cents: number;
  patient_responsibility_cents: number;
  line_item_details: Array<{
    gross_cents: number;
    adjustment_cents: number;
    insurance_paid_cents: number;
    tax_cents: number;
    patient_responsibility_cents: number;
  }>;
}

/**
 * Calculate patient responsibility for an invoice.
 *
 * This is the main billing calculation function. It determines what the
 * patient owes after insurance payments and adjustments.
 *
 * The calculation is:
 *   Patient Responsibility = Gross Charges - Contractual Adjustments
 *                           - Insurance Payments - Other Adjustments + Tax
 *
 * We use Decimal.js for all money math to avoid floating point issues.
 * JavaScript's native numbers can't handle money accurately - e.g.,
 * 0.1 + 0.2 !== 0.3 in JavaScript. Since we're dealing with actual
 * patient bills, precision matters.
 *
 * NOTE: This function has grown organically and handles too many cases.
 * It started as a simple calculation and now handles:
 * - Standard patient responsibility after insurance
 * - Prompt-pay discounts
 * - Charity care adjustments
 * - Bad debt write-offs
 * - Multi-payer scenarios (primary + secondary insurance)
 * - Tax on non-medical services
 * - Provider contractual adjustments
 *
 * It should probably be refactored into a pipeline/chain of responsibility
 * pattern, but it works and has good test coverage so we're leaving it.
 * - Alex, 2024-08
 */
export function calculatePatientResponsibility(
  lineItems: LineItemInput[],
  adjustments: AdjustmentInput[] = [],
): CalculationResult {
  if (!lineItems || lineItems.length === 0) {
    return {
      subtotal_cents: 0,
      tax_cents: 0,
      total_adjustments_cents: 0,
      total_insurance_paid_cents: 0,
      patient_responsibility_cents: 0,
      line_item_details: [],
    };
  }

  let subtotal = new Decimal(0);
  let totalTax = new Decimal(0);
  let totalAdjustments = new Decimal(0);
  let totalInsurancePaid = new Decimal(0);
  const lineItemDetails: CalculationResult['line_item_details'] = [];

  for (const item of lineItems) {
    const quantity = new Decimal(item.quantity || 1);
    const unitPrice = new Decimal(item.unit_price_cents);
    const gross = quantity.times(unitPrice);

    const adjustment = new Decimal(item.adjustment_cents || 0);
    const insurancePaid = new Decimal(item.insurance_paid_cents || 0);

    // Calculate tax
    let tax: Decimal;
    if (item.tax_cents !== undefined && item.tax_cents !== null) {
      tax = new Decimal(item.tax_cents);
    } else if (item.tax_rate) {
      // Calculate tax on the amount after adjustments but before insurance
      // This is how most states handle medical sales tax (for non-exempt items)
      const taxableAmount = gross.minus(adjustment);
      tax = taxableAmount.times(new Decimal(item.tax_rate).dividedBy(100));
      // Round tax to nearest cent
      tax = tax.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    } else {
      tax = new Decimal(0);
    }

    // Patient responsibility for this line item
    // = gross - adjustment - insurance_paid + tax
    let patientResp = gross.minus(adjustment).minus(insurancePaid).plus(tax);

    // Patient responsibility can't be negative per line item
    // (overpayments by insurance should be handled separately as credits)
    // ACTUALLY: there was a bug where secondary insurance overpaid and we
    // were showing negative patient responsibility on statements. We now
    // floor at zero per line item. The overpayment gets tracked separately.
    if (patientResp.lessThan(0)) {
      patientResp = new Decimal(0);
    }

    subtotal = subtotal.plus(gross);
    totalTax = totalTax.plus(tax);
    totalAdjustments = totalAdjustments.plus(adjustment);
    totalInsurancePaid = totalInsurancePaid.plus(insurancePaid);

    lineItemDetails.push({
      gross_cents: gross.toNumber(),
      adjustment_cents: adjustment.toNumber(),
      insurance_paid_cents: insurancePaid.toNumber(),
      tax_cents: tax.toNumber(),
      patient_responsibility_cents: patientResp.toNumber(),
    });
  }

  // Apply invoice-level adjustments (discounts, write-offs, etc.)
  let invoiceLevelAdjustments = new Decimal(0);
  for (const adj of adjustments) {
    invoiceLevelAdjustments = invoiceLevelAdjustments.plus(new Decimal(adj.amount_cents));
  }
  totalAdjustments = totalAdjustments.plus(invoiceLevelAdjustments);

  // Final patient responsibility
  let patientResponsibility = subtotal
    .minus(totalAdjustments)
    .minus(totalInsurancePaid)
    .plus(totalTax);

  // Floor at zero
  if (patientResponsibility.lessThan(0)) {
    patientResponsibility = new Decimal(0);
  }

  return {
    subtotal_cents: subtotal.toNumber(),
    tax_cents: totalTax.toNumber(),
    total_adjustments_cents: totalAdjustments.toNumber(),
    total_insurance_paid_cents: totalInsurancePaid.toNumber(),
    patient_responsibility_cents: patientResponsibility.toNumber(),
    line_item_details: lineItemDetails,
  };
}

/**
 * Calculate aging buckets for an accounts receivable report.
 *
 * Standard aging buckets:
 * - Current (0-30 days)
 * - 31-60 days
 * - 61-90 days
 * - 91-120 days
 * - 120+ days
 */
export async function calculateAgingReport(patientId?: string): Promise<any> {
  const pool = getPool();

  let query = `
    SELECT
      CASE
        WHEN CURRENT_DATE - due_date <= 30 THEN 'current'
        WHEN CURRENT_DATE - due_date BETWEEN 31 AND 60 THEN '31-60'
        WHEN CURRENT_DATE - due_date BETWEEN 61 AND 90 THEN '61-90'
        WHEN CURRENT_DATE - due_date BETWEEN 91 AND 120 THEN '91-120'
        ELSE '120+'
      END as bucket,
      COUNT(*) as invoice_count,
      SUM(balance_due_cents) as total_cents
    FROM invoices
    WHERE voided_at IS NULL
      AND status NOT IN ('paid', 'voided', 'write_off')
      AND balance_due_cents > 0
  `;

  const params: any[] = [];
  if (patientId) {
    query += ' AND patient_id = $1';
    params.push(patientId);
  }

  query += ` GROUP BY bucket ORDER BY
    CASE bucket
      WHEN 'current' THEN 1
      WHEN '31-60' THEN 2
      WHEN '61-90' THEN 3
      WHEN '91-120' THEN 4
      WHEN '120+' THEN 5
    END`;

  const result = await pool.query(query, params);

  // Ensure all buckets are present even if empty
  const buckets = ['current', '31-60', '61-90', '91-120', '120+'];
  const report = buckets.map(bucket => {
    const row = result.rows.find((r: any) => r.bucket === bucket);
    return {
      bucket,
      invoice_count: row ? parseInt(row.invoice_count) : 0,
      total: row ? parseInt(row.total_cents) / 100 : 0,
    };
  });

  const grandTotal = report.reduce((sum, b) => sum + b.total, 0);

  return {
    buckets: report,
    grand_total: grandTotal,
    generated_at: new Date().toISOString(),
    patient_id: patientId || 'all',
  };
}

/**
 * Determine copay, coinsurance, and deductible for a patient visit.
 *
 * This is a simplified version - in reality this would need to:
 * 1. Look up the patient's insurance plan
 * 2. Check the benefit details for the service type
 * 3. Check if deductible has been met
 * 4. Apply copay/coinsurance based on network status
 *
 * We currently get most of this from the claims adjudication response (ERA/835),
 * but for real-time estimates (before the claim is processed) we use these
 * hardcoded defaults. This is obviously not great.
 *
 * TODO: integrate with the eligibility verification service to get
 * actual benefit details in real-time (PLAT-5501)
 */
export function estimatePatientCostShare(params: {
  service_type: string;
  charge_amount_cents: number;
  is_in_network: boolean;
  has_met_deductible: boolean;
  remaining_deductible_cents?: number;
  plan_type?: string; // HMO, PPO, etc.
}): {
  copay_cents: number;
  coinsurance_percent: number;
  deductible_applied_cents: number;
  estimated_patient_responsibility_cents: number;
} {
  // Default copays by service type (these are ballpark figures)
  const copayDefaults: Record<string, number> = {
    'office_visit_primary': 2500, // $25
    'office_visit_specialist': 5000, // $50
    'urgent_care': 7500, // $75
    'emergency': 25000, // $250
    'lab_work': 0, // usually covered after deductible
    'imaging': 10000, // $100
    'surgery': 0, // subject to deductible + coinsurance
    'physical_therapy': 4000, // $40
    'mental_health': 3000, // $30
    'telehealth': 1500, // $15
    'preventive': 0, // covered at 100% for ACA-compliant plans
  };

  const coinsuranceDefaults: Record<string, number> = {
    'in_network': 20, // 20%
    'out_of_network': 40, // 40%
  };

  const copay = copayDefaults[params.service_type] || 5000; // default $50
  const coinsurancePercent = params.is_in_network
    ? coinsuranceDefaults['in_network']
    : coinsuranceDefaults['out_of_network'];

  let deductibleApplied = 0;
  let chargeAfterCopay = params.charge_amount_cents - copay;

  if (!params.has_met_deductible && params.remaining_deductible_cents) {
    deductibleApplied = Math.min(chargeAfterCopay, params.remaining_deductible_cents);
    chargeAfterCopay -= deductibleApplied;
  }

  // Coinsurance on the remaining amount
  const coinsuranceAmount = Math.round(chargeAfterCopay * (coinsurancePercent / 100));

  const totalPatientResponsibility = copay + deductibleApplied + coinsuranceAmount;

  return {
    copay_cents: copay,
    coinsurance_percent: coinsurancePercent,
    deductible_applied_cents: deductibleApplied,
    estimated_patient_responsibility_cents: Math.max(0, totalPatientResponsibility),
  };
}
