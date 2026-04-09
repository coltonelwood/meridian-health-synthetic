import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { InvoiceStatus, CreateInvoiceInput } from '../models/Invoice';
import { calculatePatientResponsibility } from '../services/billingService';

const router = Router();

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * GET /api/v1/invoices
 * List invoices with filters
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const {
      patient_id,
      status,
      from_date,
      to_date,
      min_balance, // in dollars, we convert to cents
      overdue_only,
      page = '1',
      page_size = '25',
      sort = 'invoice_date',
      order = 'desc',
    } = req.query;

    const conditions: string[] = ['i.voided_at IS NULL'];
    const params: any[] = [];
    let paramIndex = 1;

    if (patient_id) {
      conditions.push(`i.patient_id = $${paramIndex++}`);
      params.push(patient_id);
    }

    if (status) {
      // Accept comma-separated statuses
      const statuses = (status as string).split(',');
      conditions.push(`i.status = ANY($${paramIndex++})`);
      params.push(statuses);
    }

    if (from_date) {
      conditions.push(`i.invoice_date >= $${paramIndex++}`);
      params.push(from_date);
    }

    if (to_date) {
      conditions.push(`i.invoice_date <= $${paramIndex++}`);
      params.push(to_date);
    }

    if (min_balance) {
      const minBalanceCents = Math.round(parseFloat(min_balance as string) * 100);
      conditions.push(`i.balance_due_cents >= $${paramIndex++}`);
      params.push(minBalanceCents);
    }

    if (overdue_only === 'true') {
      conditions.push(`i.due_date < CURRENT_DATE AND i.balance_due_cents > 0`);
    }

    const parsedPageSize = Math.min(parseInt(page_size as string) || 25, 100);
    const parsedPage = Math.max(parseInt(page as string) || 1, 1);
    const offset = (parsedPage - 1) * parsedPageSize;

    // Validate sort field to prevent SQL injection
    const allowedSorts = ['invoice_date', 'due_date', 'balance_due_cents', 'total_patient_responsibility_cents', 'invoice_number', 'created_at'];
    const sortField = allowedSorts.includes(sort as string) ? sort : 'invoice_date';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const whereClause = conditions.join(' AND ');

    // Count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM invoices i WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Fetch
    params.push(parsedPageSize, offset);
    const result = await pool.query(
      `SELECT i.*,
        (SELECT COALESCE(SUM(pa.amount_cents), 0) FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id
         WHERE pa.invoice_id = i.id AND p.status = 'completed') as total_applied_payments
      FROM invoices i
      WHERE ${whereClause}
      ORDER BY i.${sortField} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    // Convert cents to dollars for the API response
    // Because the frontend team got tired of dividing by 100 everywhere
    const invoices = result.rows.map(formatInvoiceForResponse);

    res.json({
      data: invoices,
      pagination: {
        page: parsedPage,
        page_size: parsedPageSize,
        total,
        total_pages: Math.ceil(total / parsedPageSize),
      },
      // Summary stats for the filtered set
      summary: {
        total_balance_due: result.rows.reduce((sum: number, inv: any) =>
          sum + inv.balance_due_cents, 0) / 100,
        overdue_count: result.rows.filter((inv: any) =>
          new Date(inv.due_date) < new Date() && inv.balance_due_cents > 0
        ).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/invoices/:id
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND voided_at IS NULL',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Get line items
    const lineItems = await pool.query(
      'SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY line_number',
      [id]
    );

    // Get adjustments
    const adjustments = await pool.query(
      'SELECT * FROM invoice_adjustments WHERE invoice_id = $1 ORDER BY applied_at',
      [id]
    );

    // Get payment allocations
    const payments = await pool.query(`
      SELECT pa.*, p.payment_reference, p.method, p.status as payment_status,
             p.card_last_four, p.card_brand, p.processed_at
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE pa.invoice_id = $1
      ORDER BY pa.applied_at DESC
    `, [id]);

    const invoice = formatInvoiceForResponse(result.rows[0]);
    invoice.line_items = lineItems.rows.map(formatLineItemForResponse);
    invoice.adjustments = adjustments.rows;
    invoice.payments = payments.rows;

    res.json({ data: invoice });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/invoices
 * Create a new invoice
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();
    const input = req.body;

    // Validate required fields
    if (!input.patient_id || !input.billing_provider_id) {
      return res.status(400).json({
        error: 'patient_id and billing_provider_id are required',
      });
    }

    if (!input.line_items?.length) {
      return res.status(400).json({
        error: 'At least one line item is required',
      });
    }

    const id = uuidv4();
    const now = new Date();

    // Generate invoice number
    // Format: INV-YYYY-NNNNNN
    // We use a sequence to avoid race conditions
    const seqResult = await pool.query("SELECT nextval('invoice_number_seq')");
    const seqNum = seqResult.rows[0].nextval;
    const invoiceNumber = `INV-${now.getFullYear()}-${String(seqNum).padStart(6, '0')}`;

    // Calculate totals using Decimal.js
    const calculation = calculatePatientResponsibility(input.line_items, input.adjustments || []);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert invoice
      await client.query(`
        INSERT INTO invoices (
          id, invoice_number, patient_id, guarantor_id, patient_name,
          encounter_id, claim_id, billing_provider_id, billing_provider_npi,
          facility_id, invoice_date, due_date, service_date, service_date_end,
          status, subtotal_cents, tax_cents, total_adjustments_cents,
          total_insurance_paid_cents, total_patient_responsibility_cents,
          total_payments_cents, balance_due_cents,
          primary_insurance_id, primary_insurance_name,
          secondary_insurance_id, payment_terms_days,
          statement_count, sent_to_collections,
          internal_notes, patient_notes,
          created_at, updated_at, created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
          $27, $28, $29, $30, $31, $32, $33
        )
      `, [
        id, invoiceNumber, input.patient_id, input.guarantor_id, input.patient_name,
        input.encounter_id, input.claim_id, input.billing_provider_id,
        input.billing_provider_npi, input.facility_id,
        input.invoice_date || now.toISOString().split('T')[0],
        input.due_date || calculateDueDate(now, input.payment_terms_days || 30),
        input.service_date, input.service_date_end,
        input.status || InvoiceStatus.DRAFT,
        calculation.subtotal_cents, calculation.tax_cents,
        calculation.total_adjustments_cents, calculation.total_insurance_paid_cents,
        calculation.patient_responsibility_cents, 0,
        calculation.patient_responsibility_cents, // balance = responsibility - payments(0)
        input.primary_insurance_id, input.primary_insurance_name,
        input.secondary_insurance_id, input.payment_terms_days || 30,
        0, false,
        input.internal_notes, input.patient_notes,
        now, now, input.created_by,
      ]);

      // Insert line items
      for (let i = 0; i < input.line_items.length; i++) {
        const item = input.line_items[i];
        await client.query(`
          INSERT INTO invoice_line_items (
            id, invoice_id, line_number, description,
            charge_code, charge_code_type, service_date, service_date_end,
            quantity, unit_price_cents, total_cents,
            adjustment_cents, adjustment_reason,
            insurance_paid_cents, patient_responsibility_cents,
            tax_cents, modifiers, diagnosis_pointers,
            rendering_provider_npi
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19
          )
        `, [
          uuidv4(), id, i + 1, item.description,
          item.charge_code, item.charge_code_type,
          item.service_date, item.service_date_end,
          item.quantity || 1, item.unit_price_cents,
          (item.quantity || 1) * item.unit_price_cents,
          item.adjustment_cents || 0, item.adjustment_reason,
          item.insurance_paid_cents || 0, item.patient_responsibility_cents || item.unit_price_cents,
          item.tax_cents || 0, item.modifiers || [], item.diagnosis_pointers || [],
          item.rendering_provider_npi,
        ]);
      }

      await client.query('COMMIT');

      logger.info('Invoice created', {
        invoiceId: id,
        invoiceNumber,
        patientId: input.patient_id,
        totalCents: calculation.patient_responsibility_cents,
      });

      res.status(201).json({
        data: {
          id,
          invoice_number: invoiceNumber,
          balance_due: calculation.patient_responsibility_cents / 100,
          status: input.status || InvoiceStatus.DRAFT,
        },
        message: 'Invoice created successfully',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/invoices/:id/status
 * Update invoice status
 */
router.put('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!status || !Object.values(InvoiceStatus).includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        valid_statuses: Object.values(InvoiceStatus),
      });
    }

    // Validate status transitions
    const current = await pool.query(
      'SELECT status FROM invoices WHERE id = $1 AND voided_at IS NULL',
      [id]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const currentStatus = current.rows[0].status;
    if (!isValidStatusTransition(currentStatus, status)) {
      return res.status(400).json({
        error: 'Invalid status transition',
        message: `Cannot transition from ${currentStatus} to ${status}`,
      });
    }

    await pool.query(
      `UPDATE invoices SET status = $1, status_changed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [status, id]
    );

    getLogger().info('Invoice status updated', { invoiceId: id, from: currentStatus, to: status });

    res.json({ message: 'Status updated', id, status });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/invoices/:id/void
 * Void an invoice
 */
router.post('/:id/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const { reason, voided_by } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Void reason is required' });
    }

    // Check for payments
    const payments = await pool.query(`
      SELECT COALESCE(SUM(pa.amount_cents), 0) as total_paid
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE pa.invoice_id = $1 AND p.status = 'completed'
    `, [id]);

    if (parseInt(payments.rows[0].total_paid) > 0) {
      return res.status(400).json({
        error: 'Cannot void invoice with payments',
        message: 'Refund or reverse payments before voiding the invoice',
        total_paid_cents: parseInt(payments.rows[0].total_paid),
      });
    }

    const result = await pool.query(
      `UPDATE invoices SET
        status = $1, voided_at = NOW(), voided_by = $2, void_reason = $3,
        balance_due_cents = 0, updated_at = NOW()
       WHERE id = $4 AND voided_at IS NULL
       RETURNING id`,
      [InvoiceStatus.VOIDED, voided_by, reason, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found or already voided' });
    }

    res.json({ message: 'Invoice voided', id });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/invoices/patient/:patientId/summary
 * Get billing summary for a patient
 */
router.get('/patient/:patientId/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { patientId } = req.params;

    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('voided', 'write_off')) as total_invoices,
        COALESCE(SUM(balance_due_cents) FILTER (WHERE status NOT IN ('voided', 'write_off', 'paid')), 0) as total_outstanding_cents,
        COALESCE(SUM(total_payments_cents) FILTER (WHERE status NOT IN ('voided')), 0) as total_paid_cents,
        COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND balance_due_cents > 0 AND status NOT IN ('voided', 'write_off')) as overdue_count,
        COALESCE(SUM(balance_due_cents) FILTER (WHERE due_date < CURRENT_DATE AND balance_due_cents > 0 AND status NOT IN ('voided', 'write_off')), 0) as overdue_amount_cents,
        MIN(invoice_date) FILTER (WHERE status NOT IN ('voided')) as earliest_invoice,
        MAX(invoice_date) FILTER (WHERE status NOT IN ('voided')) as latest_invoice
      FROM invoices
      WHERE patient_id = $1 AND voided_at IS NULL
    `, [patientId]);

    const summary = result.rows[0];

    res.json({
      data: {
        patient_id: patientId,
        total_invoices: parseInt(summary.total_invoices),
        total_outstanding: parseInt(summary.total_outstanding_cents) / 100,
        total_paid: parseInt(summary.total_paid_cents) / 100,
        overdue_count: parseInt(summary.overdue_count),
        overdue_amount: parseInt(summary.overdue_amount_cents) / 100,
        earliest_invoice: summary.earliest_invoice,
        latest_invoice: summary.latest_invoice,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Status transition validation
// This is intentionally lenient - we allow some "backwards" transitions
// because billing workflows are messy
function isValidStatusTransition(from: string, to: string): boolean {
  // Can always void
  if (to === InvoiceStatus.VOIDED) return true;

  // These transitions are blocked
  const blocked: Record<string, string[]> = {
    [InvoiceStatus.VOIDED]: ['*'], // can't un-void
    [InvoiceStatus.PAID]: [InvoiceStatus.DRAFT, InvoiceStatus.PENDING],
  };

  if (blocked[from]) {
    if (blocked[from].includes('*')) return false;
    if (blocked[from].includes(to)) return false;
  }

  return true;
}

function calculateDueDate(fromDate: Date, termsDays: number): string {
  const due = new Date(fromDate);
  due.setDate(due.getDate() + termsDays);
  return due.toISOString().split('T')[0];
}

function formatInvoiceForResponse(row: any): any {
  return {
    ...row,
    // Convert cents to dollars for API consumers
    subtotal: row.subtotal_cents / 100,
    tax: row.tax_cents / 100,
    total_adjustments: row.total_adjustments_cents / 100,
    total_insurance_paid: row.total_insurance_paid_cents / 100,
    total_patient_responsibility: row.total_patient_responsibility_cents / 100,
    total_payments: row.total_payments_cents / 100,
    balance_due: row.balance_due_cents / 100,
  };
}

function formatLineItemForResponse(row: any): any {
  return {
    ...row,
    unit_price: row.unit_price_cents / 100,
    total: row.total_cents / 100,
    adjustment: row.adjustment_cents / 100,
    insurance_paid: row.insurance_paid_cents / 100,
    patient_responsibility: row.patient_responsibility_cents / 100,
    tax: row.tax_cents / 100,
  };
}

export default router;
