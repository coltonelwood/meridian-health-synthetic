import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { PaymentMethod, PaymentStatus, CreatePaymentInput } from '../models/Payment';
import { processStripePayment, handleStripeWebhook } from '../services/stripeIntegration';

const router = Router();

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * GET /api/v1/payments
 * List payments
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const {
      patient_id,
      invoice_id,
      status,
      method,
      from_date,
      to_date,
      page = '1',
      page_size = '25',
    } = req.query;

    const conditions: string[] = ['p.voided_at IS NULL'];
    const params: any[] = [];
    let paramIndex = 1;

    if (patient_id) {
      conditions.push(`p.patient_id = $${paramIndex++}`);
      params.push(patient_id);
    }

    if (invoice_id) {
      conditions.push(`EXISTS (
        SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = p.id AND pa.invoice_id = $${paramIndex++}
      )`);
      params.push(invoice_id);
    }

    if (status) {
      conditions.push(`p.status = $${paramIndex++}`);
      params.push(status);
    }

    if (method) {
      conditions.push(`p.method = $${paramIndex++}`);
      params.push(method);
    }

    if (from_date) {
      conditions.push(`p.created_at >= $${paramIndex++}`);
      params.push(from_date);
    }

    if (to_date) {
      conditions.push(`p.created_at <= $${paramIndex++}`);
      params.push(to_date);
    }

    const parsedPageSize = Math.min(parseInt(page_size as string) || 25, 100);
    const parsedPage = Math.max(parseInt(page as string) || 1, 1);
    const offset = (parsedPage - 1) * parsedPageSize;

    const whereClause = conditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM payments p WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    params.push(parsedPageSize, offset);
    const result = await pool.query(
      `SELECT p.*,
        (SELECT json_agg(json_build_object(
          'invoice_id', pa.invoice_id,
          'amount_cents', pa.amount_cents
        )) FROM payment_allocations pa WHERE pa.payment_id = p.id) as allocations
      FROM payments p
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    const payments = result.rows.map((row: any) => ({
      ...row,
      amount: row.amount_cents / 100,
      refund_amount: row.refund_amount_cents ? row.refund_amount_cents / 100 : null,
      processing_fee: row.processing_fee_cents ? row.processing_fee_cents / 100 : null,
    }));

    res.json({
      data: payments,
      pagination: {
        page: parsedPage,
        page_size: parsedPageSize,
        total,
        total_pages: Math.ceil(total / parsedPageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/payments
 * Process a new payment
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();
    const input: CreatePaymentInput = req.body;

    // Validate
    if (!input.patient_id || !input.amount_cents || !input.method) {
      return res.status(400).json({
        error: 'patient_id, amount_cents, and method are required',
      });
    }

    if (input.amount_cents <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    // If allocations specified, verify they match the total
    if (input.allocations?.length) {
      const allocTotal = input.allocations.reduce((sum, a) => sum + a.amount_cents, 0);
      if (allocTotal !== input.amount_cents) {
        return res.status(400).json({
          error: 'Allocation amounts must equal payment amount',
          payment_amount: input.amount_cents,
          allocation_total: allocTotal,
        });
      }

      // Verify invoices exist and have sufficient balance
      for (const alloc of input.allocations) {
        const inv = await pool.query(
          'SELECT balance_due_cents FROM invoices WHERE id = $1 AND voided_at IS NULL',
          [alloc.invoice_id]
        );
        if (inv.rows.length === 0) {
          return res.status(400).json({
            error: `Invoice ${alloc.invoice_id} not found`,
          });
        }
        // Allow overpayment (creates credit) - this is intentional
        // but should probably be a warning
        if (alloc.amount_cents > inv.rows[0].balance_due_cents) {
          logger.warn('Payment exceeds invoice balance', {
            invoiceId: alloc.invoice_id,
            balance: inv.rows[0].balance_due_cents,
            paymentAmount: alloc.amount_cents,
          });
        }
      }
    }

    const id = uuidv4();
    const now = new Date();

    // Generate payment reference
    const seqResult = await pool.query("SELECT nextval('payment_number_seq')");
    const seqNum = seqResult.rows[0].nextval;
    const paymentRef = `PAY-${now.getFullYear()}-${String(seqNum).padStart(6, '0')}`;

    let paymentStatus = PaymentStatus.PENDING;
    let stripeResult: any = null;

    // Process via Stripe for card payments
    if (input.method === PaymentMethod.CREDIT_CARD || input.method === PaymentMethod.DEBIT_CARD) {
      if (!input.stripe_payment_intent_id && !req.body.stripe_token) {
        return res.status(400).json({
          error: 'stripe_payment_intent_id or stripe_token required for card payments',
        });
      }

      try {
        stripeResult = await processStripePayment({
          amount_cents: input.amount_cents,
          currency: input.currency || 'usd',
          stripe_payment_intent_id: input.stripe_payment_intent_id,
          stripe_token: req.body.stripe_token,
          stripe_customer_id: input.stripe_customer_id,
          patient_id: input.patient_id,
          description: `Payment for ${paymentRef}`,
          metadata: {
            payment_id: id,
            payment_reference: paymentRef,
            patient_id: input.patient_id,
          },
        });
        paymentStatus = stripeResult.status === 'succeeded'
          ? PaymentStatus.COMPLETED
          : PaymentStatus.PROCESSING;
      } catch (stripeErr: any) {
        logger.error('Stripe payment failed', {
          error: stripeErr.message,
          paymentId: id,
        });
        return res.status(400).json({
          error: 'Payment processing failed',
          message: stripeErr.message,
          // TODO: don't expose Stripe error codes in production
          stripe_code: stripeErr.code,
        });
      }
    } else if (input.method === PaymentMethod.CASH || input.method === PaymentMethod.CHECK) {
      // Manual payments are immediately completed
      paymentStatus = PaymentStatus.COMPLETED;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert payment
      await client.query(`
        INSERT INTO payments (
          id, payment_reference, patient_id, patient_name,
          invoice_id, amount_cents, currency, method, status,
          stripe_payment_intent_id, stripe_charge_id, stripe_customer_id,
          stripe_receipt_url,
          card_last_four, card_brand, card_exp_month, card_exp_year,
          check_number, check_date,
          processed_at, processing_fee_cents,
          receipt_sent, internal_notes, memo,
          created_at, updated_at, created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23, $24, $25, $26, $27
        )
      `, [
        id, paymentRef, input.patient_id, input.patient_name,
        input.invoice_id, input.amount_cents, input.currency || 'usd',
        input.method, paymentStatus,
        stripeResult?.paymentIntentId || input.stripe_payment_intent_id,
        stripeResult?.chargeId, input.stripe_customer_id,
        stripeResult?.receiptUrl,
        stripeResult?.cardLastFour || input.card_last_four,
        stripeResult?.cardBrand || input.card_brand,
        input.card_exp_month, input.card_exp_year,
        input.check_number, input.check_date,
        paymentStatus === PaymentStatus.COMPLETED ? now : null,
        stripeResult?.processingFee || null,
        false, input.internal_notes, input.memo,
        now, now, input.created_by,
      ]);

      // Create allocations and update invoice balances
      if (paymentStatus === PaymentStatus.COMPLETED && input.allocations?.length) {
        for (const alloc of input.allocations) {
          await client.query(`
            INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_cents, applied_at)
            VALUES ($1, $2, $3, $4, $5)
          `, [uuidv4(), id, alloc.invoice_id, alloc.amount_cents, now]);

          // Update invoice balance
          await client.query(`
            UPDATE invoices SET
              total_payments_cents = total_payments_cents + $1,
              balance_due_cents = GREATEST(0, balance_due_cents - $1),
              status = CASE
                WHEN balance_due_cents - $1 <= 0 THEN 'paid'
                WHEN balance_due_cents - $1 > 0 THEN 'partially_paid'
                ELSE status
              END,
              updated_at = NOW()
            WHERE id = $2
          `, [alloc.amount_cents, alloc.invoice_id]);
        }
      } else if (paymentStatus === PaymentStatus.COMPLETED && input.invoice_id) {
        // Legacy single-invoice payment path
        await client.query(`
          INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_cents, applied_at)
          VALUES ($1, $2, $3, $4, $5)
        `, [uuidv4(), id, input.invoice_id, input.amount_cents, now]);

        await client.query(`
          UPDATE invoices SET
            total_payments_cents = total_payments_cents + $1,
            balance_due_cents = GREATEST(0, balance_due_cents - $1),
            status = CASE
              WHEN balance_due_cents - $1 <= 0 THEN 'paid'
              ELSE 'partially_paid'
            END,
            updated_at = NOW()
          WHERE id = $2
        `, [input.amount_cents, input.invoice_id]);
      }

      await client.query('COMMIT');

      logger.info('Payment processed', {
        paymentId: id,
        paymentRef,
        amount: input.amount_cents,
        method: input.method,
        status: paymentStatus,
      });

      res.status(201).json({
        data: {
          id,
          payment_reference: paymentRef,
          amount: input.amount_cents / 100,
          status: paymentStatus,
          receipt_url: stripeResult?.receiptUrl,
        },
        message: paymentStatus === PaymentStatus.COMPLETED
          ? 'Payment processed successfully'
          : 'Payment is being processed',
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
 * POST /api/v1/payments/:id/refund
 * Refund a payment
 */
router.post('/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();
    const { id } = req.params;
    const { amount_cents, reason } = req.body;

    const payment = await pool.query(
      'SELECT * FROM payments WHERE id = $1 AND voided_at IS NULL',
      [id]
    );

    if (payment.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const p = payment.rows[0];

    if (p.status !== PaymentStatus.COMPLETED) {
      return res.status(400).json({
        error: 'Can only refund completed payments',
        current_status: p.status,
      });
    }

    const refundAmount = amount_cents || p.amount_cents;
    const alreadyRefunded = p.refund_amount_cents || 0;

    if (refundAmount + alreadyRefunded > p.amount_cents) {
      return res.status(400).json({
        error: 'Refund amount exceeds payment',
        max_refundable: p.amount_cents - alreadyRefunded,
      });
    }

    // Process Stripe refund if applicable
    if (p.stripe_charge_id || p.stripe_payment_intent_id) {
      // TODO: actually process the Stripe refund
      // For now we just update our records and manually process in Stripe dashboard
      // This is terrible but we're under time pressure - ticket: PLAT-6890
      logger.warn('Stripe refund needs manual processing', {
        paymentId: id,
        stripeChargeId: p.stripe_charge_id,
        refundAmount,
      });
    }

    const newStatus = (refundAmount + alreadyRefunded) === p.amount_cents
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIALLY_REFUNDED;

    await pool.query(`
      UPDATE payments SET
        status = $1,
        refund_amount_cents = COALESCE(refund_amount_cents, 0) + $2,
        refund_reason = $3,
        refund_date = NOW(),
        updated_at = NOW()
      WHERE id = $4
    `, [newStatus, refundAmount, reason || 'Refund requested', id]);

    // TODO: reverse the invoice balance updates
    // This is a known gap - when we refund, we should increase the
    // invoice balance_due back. But the allocation reversal logic
    // is complex when a payment spans multiple invoices.
    // For now the finance team does this manually. (PLAT-7012)

    logger.info('Payment refunded', {
      paymentId: id,
      refundAmount,
      newStatus,
    });

    res.json({
      message: 'Refund processed',
      data: { id, status: newStatus, refund_amount: refundAmount / 100 },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /webhooks/stripe
 * Stripe webhook handler
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const logger = getLogger();

  try {
    const result = await handleStripeWebhook(req);
    res.json({ received: true, ...result });
  } catch (err: any) {
    logger.error('Stripe webhook error', { error: err.message });
    // Always return 200 to Stripe or they'll retry
    // TODO: actually we should return 400 for signature failures
    // and 200 for processing errors. Fix this.
    res.status(200).json({ received: true, error: err.message });
  }
});

export default router;
