import Stripe from 'stripe';
import { Request } from 'express';
import { Pool } from 'pg';
import { PaymentStatus } from '../models/Payment';

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

// Initialize Stripe
// TODO: handle the case where STRIPE_SECRET_KEY is not set more gracefully
// Right now it just throws when you try to use it, which gives a confusing error
let stripe: Stripe | null = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16',
      // typescript: true, // deprecated option, left here for reference
      maxNetworkRetries: 2,
      timeout: 30000,
    });
  }
} catch (err) {
  console.error('Failed to initialize Stripe:', err);
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

interface ProcessPaymentParams {
  amount_cents: number;
  currency: string;
  stripe_payment_intent_id?: string;
  stripe_token?: string;
  stripe_customer_id?: string;
  patient_id: string;
  description?: string;
  metadata?: Record<string, string>;
}

interface ProcessPaymentResult {
  paymentIntentId: string;
  chargeId?: string;
  status: string;
  receiptUrl?: string;
  cardLastFour?: string;
  cardBrand?: string;
  processingFee?: number;
}

/**
 * Process a payment through Stripe.
 *
 * We support two flows:
 * 1. Payment Intent (recommended) - client creates PI, we confirm it
 * 2. Token (legacy) - client tokenizes card, we create charge
 *
 * The token flow is deprecated by Stripe but some of our older
 * mobile app versions still use it. We should remove it eventually.
 *
 * Known issues:
 * - We don't handle 3D Secure / SCA properly for European cards
 * - The idempotency key is generated per request, so retries create
 *   new payment intents instead of reusing. Need to pass idempotency
 *   key from the client. (PLAT-6234)
 * - Processing fees are estimated, not exact. We reconcile with
 *   actual Stripe fees in the nightly batch job.
 */
export async function processStripePayment(
  params: ProcessPaymentParams
): Promise<ProcessPaymentResult> {
  if (!stripe) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY environment variable.');
  }

  const logger = getLogger();

  // Flow 1: Confirm existing Payment Intent
  if (params.stripe_payment_intent_id) {
    logger.info('Confirming Payment Intent', {
      piId: params.stripe_payment_intent_id,
    });

    const paymentIntent = await stripe.paymentIntents.retrieve(
      params.stripe_payment_intent_id,
      { expand: ['latest_charge'] }
    );

    // Verify amount matches
    if (paymentIntent.amount !== params.amount_cents) {
      throw new Error(
        `Payment Intent amount (${paymentIntent.amount}) does not match ` +
        `expected amount (${params.amount_cents})`
      );
    }

    if (paymentIntent.status === 'requires_confirmation') {
      const confirmed = await stripe.paymentIntents.confirm(
        params.stripe_payment_intent_id
      );
      return mapPaymentIntentToResult(confirmed);
    }

    if (paymentIntent.status === 'succeeded') {
      return mapPaymentIntentToResult(paymentIntent);
    }

    if (paymentIntent.status === 'requires_action') {
      // 3D Secure or other authentication needed
      // TODO: handle this properly - right now we just tell the client
      // and hope they figure it out
      return {
        paymentIntentId: paymentIntent.id,
        status: 'requires_action',
      };
    }

    throw new Error(`Unexpected Payment Intent status: ${paymentIntent.status}`);
  }

  // Flow 2: Create from token (legacy)
  if (params.stripe_token) {
    logger.warn('Using legacy token-based payment flow', {
      patientId: params.patient_id,
    });

    // Create or get customer
    let customerId = params.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: {
          patient_id: params.patient_id,
          source: 'meridian-billing',
        },
      });
      customerId = customer.id;
    }

    // Attach token as payment source
    await stripe.customers.createSource(customerId, {
      source: params.stripe_token,
    });

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: params.amount_cents,
      currency: params.currency || 'usd',
      customer: customerId,
      description: params.description,
      metadata: params.metadata || {},
      confirm: true,
      // off_session: true, // uncomment for saved cards / recurring
      receipt_email: undefined, // we send our own receipts
    });

    return mapPaymentIntentToResult(paymentIntent);
  }

  throw new Error('Either stripe_payment_intent_id or stripe_token is required');
}

function mapPaymentIntentToResult(pi: Stripe.PaymentIntent): ProcessPaymentResult {
  const charge = (pi as any).latest_charge as Stripe.Charge | undefined;

  return {
    paymentIntentId: pi.id,
    chargeId: charge?.id,
    status: pi.status,
    receiptUrl: charge?.receipt_url || undefined,
    cardLastFour: (charge?.payment_method_details?.card?.last4) || undefined,
    cardBrand: (charge?.payment_method_details?.card?.brand) || undefined,
    // Estimate processing fee: 2.9% + $0.30 for US cards
    // This is an approximation - actual fees depend on card type, volume, etc.
    processingFee: Math.round(pi.amount * 0.029 + 30),
  };
}

/**
 * Handle Stripe webhook events.
 *
 * We handle:
 * - payment_intent.succeeded - mark payment as completed
 * - payment_intent.payment_failed - mark payment as failed
 * - charge.refunded - process refund
 * - charge.dispute.created - flag payment as disputed
 *
 * TODO: handle more event types:
 * - invoice.payment_succeeded (for Stripe Billing, if we ever use it)
 * - customer.subscription.* (for payment plans)
 * - charge.dispute.closed
 *
 * TODO: move webhook processing to a queue so we return 200 quickly
 * and process asynchronously. Currently if the DB is slow, Stripe
 * might time out and retry, causing duplicate processing.
 * Ticket: PLAT-6890
 */
export async function handleStripeWebhook(req: Request): Promise<{ type: string; handled: boolean }> {
  if (!stripe) {
    throw new Error('Stripe not configured');
  }

  const logger = getLogger();
  const pool = getPool();

  let event: Stripe.Event;

  // Verify webhook signature
  if (WEBHOOK_SECRET) {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      throw new Error('Missing stripe-signature header');
    }

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // raw body
        signature,
        WEBHOOK_SECRET
      );
    } catch (err: any) {
      logger.error('Webhook signature verification failed', {
        error: err.message,
      });
      throw new Error(`Webhook signature verification failed: ${err.message}`);
    }
  } else {
    // No webhook secret configured - just parse the body
    // This is insecure and should only be used in development
    logger.warn('Processing webhook without signature verification');
    event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }

  logger.info('Processing Stripe webhook', {
    type: event.type,
    id: event.id,
  });

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const paymentId = pi.metadata?.payment_id;

      if (paymentId) {
        await pool.query(`
          UPDATE payments SET
            status = $1,
            processed_at = NOW(),
            stripe_charge_id = $2,
            updated_at = NOW()
          WHERE id = $3
        `, [PaymentStatus.COMPLETED, (pi as any).latest_charge, paymentId]);

        // TODO: also update invoice balance here
        // Currently this only gets updated in the synchronous payment flow
        // Webhook-triggered updates don't update invoice balances
        // This causes discrepancies that the nightly reconciliation fixes
        logger.warn('Payment completed via webhook - invoice balance may be stale', {
          paymentId,
        });
      } else {
        logger.warn('payment_intent.succeeded without payment_id in metadata', {
          piId: pi.id,
        });
      }

      return { type: event.type, handled: true };
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const paymentId = pi.metadata?.payment_id;

      if (paymentId) {
        const failureMessage = pi.last_payment_error?.message || 'Payment failed';

        await pool.query(`
          UPDATE payments SET
            status = $1,
            internal_notes = COALESCE(internal_notes, '') || $2,
            updated_at = NOW()
          WHERE id = $3
        `, [
          PaymentStatus.FAILED,
          `\nStripe failure: ${failureMessage}`,
          paymentId,
        ]);
      }

      return { type: event.type, handled: true };
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      // Find payment by stripe charge ID
      const result = await pool.query(
        'SELECT id FROM payments WHERE stripe_charge_id = $1',
        [charge.id]
      );

      if (result.rows.length > 0) {
        const refundedAmount = charge.amount_refunded;
        const isFullRefund = refundedAmount === charge.amount;

        await pool.query(`
          UPDATE payments SET
            status = $1,
            refund_amount_cents = $2,
            refund_date = NOW(),
            updated_at = NOW()
          WHERE stripe_charge_id = $3
        `, [
          isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
          refundedAmount,
          charge.id,
        ]);
      }

      return { type: event.type, handled: true };
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;

      if (chargeId) {
        await pool.query(`
          UPDATE payments SET
            status = $1,
            internal_notes = COALESCE(internal_notes, '') || $2,
            updated_at = NOW()
          WHERE stripe_charge_id = $3
        `, [
          PaymentStatus.DISPUTED,
          `\nDispute opened: ${dispute.reason} (${dispute.id})`,
          chargeId,
        ]);

        // TODO: send notification to billing team
        // TODO: auto-respond with evidence for common dispute reasons
        logger.error('Payment disputed!', {
          chargeId,
          disputeId: dispute.id,
          reason: dispute.reason,
          amount: dispute.amount,
        });
      }

      return { type: event.type, handled: true };
    }

    default:
      logger.info('Unhandled Stripe webhook event type', { type: event.type });
      return { type: event.type, handled: false };
  }
}

/**
 * Create a Stripe customer for a patient.
 * We create Stripe customers lazily (on first payment) rather than
 * proactively for all patients.
 */
export async function getOrCreateStripeCustomer(
  patientId: string,
  email?: string,
  name?: string,
): Promise<string> {
  if (!stripe) {
    throw new Error('Stripe not configured');
  }

  const pool = getPool();

  // Check if we already have a Stripe customer for this patient
  const existing = await pool.query(
    'SELECT stripe_customer_id FROM patient_stripe_mapping WHERE patient_id = $1',
    [patientId]
  );

  if (existing.rows.length > 0 && existing.rows[0].stripe_customer_id) {
    return existing.rows[0].stripe_customer_id;
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: {
      patient_id: patientId,
      source: 'meridian-billing',
      created_by: 'billing-service',
    },
  });

  // Save mapping
  // Using ON CONFLICT in case of race condition
  await pool.query(`
    INSERT INTO patient_stripe_mapping (patient_id, stripe_customer_id, created_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (patient_id) DO UPDATE SET stripe_customer_id = $2, updated_at = NOW()
  `, [patientId, customer.id]);

  return customer.id;
}
