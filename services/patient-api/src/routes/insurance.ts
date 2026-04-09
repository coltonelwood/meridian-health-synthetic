import { Router, Request, Response } from 'express';
import { getRepository } from 'typeorm';
import { Insurance } from '../models/Insurance';
import { Patient } from '../models/Patient';

const router = Router();

/*
 * ======================================================================
 * INSURANCE / COVERAGE ENDPOINTS
 * ======================================================================
 *
 * TODO: Major refactor needed here (PLAT-7200)
 *
 * Current limitations:
 *  - Only supports single-payer per coverage type (primary/secondary/tertiary)
 *  - No support for coordination of benefits (COB)
 *  - No real-time eligibility verification (we fake it)
 *  - Subscriber vs dependent relationships are janky
 *  - No support for Medicare Advantage plans properly
 *  - Workers' comp and auto insurance are hacked in as "other"
 *
 * The payer team wants us to integrate with the Availity API for
 * real-time eligibility but we haven't had bandwidth (PLAT-5891)
 * ======================================================================
 */

/**
 * GET /api/v1/insurance/patient/:patientId
 * Get all insurance coverages for a patient
 */
router.get('/patient/:patientId', async (req: Request, res: Response) => {
  try {
    const repo = getRepository(Insurance);
    const coverages = await repo.find({
      where: { patient: { id: req.params.patientId }, isActive: true },
      order: { coverageOrder: 'ASC' },
    });

    if (coverages.length === 0) {
      // Check if patient exists at all
      const patientRepo = getRepository(Patient);
      const patient = await patientRepo.findOne({ where: { id: req.params.patientId } });
      if (!patient) {
        return res.status(404).json({ error: 'Patient not found' });
      }
      // Patient exists but has no insurance - that's valid (self-pay)
    }

    // Add computed fields
    const enriched = coverages.map(coverage => ({
      ...coverage,
      isExpired: coverage.endDate ? new Date(coverage.endDate) < new Date() : false,
      coverageLabel: getCoverageLabel(coverage.coverageOrder),
    }));

    res.json({ data: enriched });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch insurance coverages', message: error.message });
  }
});

/**
 * GET /api/v1/insurance/:id
 * Get a specific insurance coverage record
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const repo = getRepository(Insurance);
    const coverage = await repo.findOne({
      where: { id: req.params.id },
      relations: ['patient'],
    });

    if (!coverage) {
      return res.status(404).json({ error: 'Insurance coverage not found' });
    }

    res.json({ data: coverage });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch insurance coverage' });
  }
});

/**
 * POST /api/v1/insurance/patient/:patientId
 * Add insurance coverage to a patient
 */
router.post('/patient/:patientId', async (req: Request, res: Response) => {
  try {
    // Validate patient exists
    const patientRepo = getRepository(Patient);
    const patient = await patientRepo.findOne({ where: { id: req.params.patientId, isActive: true } });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const repo = getRepository(Insurance);

    // Check for existing coverage at same order level
    const existingAtOrder = await repo.findOne({
      where: {
        patient: { id: req.params.patientId },
        coverageOrder: req.body.coverageOrder || 1,
        isActive: true,
      },
    });

    if (existingAtOrder) {
      return res.status(409).json({
        error: 'Conflict',
        message: `Patient already has active ${getCoverageLabel(req.body.coverageOrder || 1)} coverage. Deactivate existing coverage first or update it.`,
        existingCoverageId: existingAtOrder.id,
      });
    }

    // Basic validation
    const errors = validateInsuranceInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation Error', details: errors });
    }

    const coverage = repo.create({
      ...req.body,
      patient: { id: req.params.patientId },
      createdBy: (req as any).user?.userId,
    });

    const saved = await repo.save(coverage);

    res.status(201).json({
      data: saved,
      message: 'Insurance coverage added successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to add insurance coverage', message: error.message });
  }
});

/**
 * PUT /api/v1/insurance/:id
 * Update an insurance coverage record
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const repo = getRepository(Insurance);
    const coverage = await repo.findOne({ where: { id: req.params.id } });

    if (!coverage) {
      return res.status(404).json({ error: 'Insurance coverage not found' });
    }

    // Don't allow changing the patient association
    delete req.body.patient;
    delete req.body.patientId;

    const errors = validateInsuranceInput(req.body, true);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation Error', details: errors });
    }

    await repo.update(req.params.id, {
      ...req.body,
      updatedBy: (req as any).user?.userId,
      updatedAt: new Date(),
    });

    const updated = await repo.findOne({ where: { id: req.params.id } });
    res.json({ data: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update insurance coverage', message: error.message });
  }
});

/**
 * DELETE /api/v1/insurance/:id
 * Deactivate an insurance coverage (soft delete)
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const repo = getRepository(Insurance);
    const coverage = await repo.findOne({ where: { id: req.params.id } });

    if (!coverage) {
      return res.status(404).json({ error: 'Insurance coverage not found' });
    }

    // Soft delete - set isActive to false and record end date
    await repo.update(req.params.id, {
      isActive: false,
      endDate: req.body.endDate || new Date().toISOString().split('T')[0],
      terminationReason: req.body.reason || 'manually_deactivated',
      updatedBy: (req as any).user?.userId,
      updatedAt: new Date(),
    });

    res.json({ message: 'Insurance coverage deactivated' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to deactivate coverage', message: error.message });
  }
});

/**
 * POST /api/v1/insurance/:id/verify
 * Verify insurance eligibility
 */
router.post('/:id/verify', async (req: Request, res: Response) => {
  // TODO: integrate with Availity or Change Healthcare for real eligibility checks (PLAT-5891)
  // For now we just return a mock response

  try {
    const repo = getRepository(Insurance);
    const coverage = await repo.findOne({
      where: { id: req.params.id },
      relations: ['patient'],
    });

    if (!coverage) {
      return res.status(404).json({ error: 'Insurance coverage not found' });
    }

    // Fake eligibility check
    // In production this would call out to the payer's 270/271 transaction
    const isExpired = coverage.endDate ? new Date(coverage.endDate) < new Date() : false;

    const verificationResult = {
      coverageId: coverage.id,
      verifiedAt: new Date().toISOString(),
      status: isExpired ? 'inactive' : 'active',
      eligible: !isExpired,
      // These would come from the payer response
      copay: null, // TODO
      deductible: null, // TODO
      deductibleMet: null, // TODO
      outOfPocketMax: null, // TODO
      coinsurance: null, // TODO
      disclaimer: 'This is a preliminary check. Actual coverage may vary. Contact payer for definitive eligibility.',
      source: 'internal', // would be 'availity' or 'change_healthcare' when we integrate
    };

    // Update last verified date
    await repo.update(req.params.id, {
      lastVerifiedAt: new Date(),
    });

    res.json({ data: verificationResult });
  } catch (error: any) {
    res.status(500).json({ error: 'Eligibility verification failed', message: error.message });
  }
});

// Helper functions

function getCoverageLabel(order: number): string {
  switch (order) {
    case 1: return 'Primary';
    case 2: return 'Secondary';
    case 3: return 'Tertiary';
    default: return `Coverage ${order}`;
  }
}

function validateInsuranceInput(data: any, isPartial = false): string[] {
  const errors: string[] = [];

  if (!isPartial) {
    if (!data.payerName) errors.push('payerName is required');
    if (!data.payerId) errors.push('payerId is required');
    if (!data.memberId) errors.push('memberId is required');
    if (!data.startDate) errors.push('startDate is required');
    if (!data.planType) errors.push('planType is required');
  }

  if (data.coverageOrder && (data.coverageOrder < 1 || data.coverageOrder > 3)) {
    // TODO: technically there can be more than 3 but we don't support it yet
    errors.push('coverageOrder must be between 1 and 3');
  }

  if (data.startDate && data.endDate) {
    if (new Date(data.startDate) > new Date(data.endDate)) {
      errors.push('startDate must be before endDate');
    }
  }

  if (data.planType && !['HMO', 'PPO', 'EPO', 'POS', 'HDHP', 'Medicare', 'Medicaid', 'Tricare', 'Other'].includes(data.planType)) {
    errors.push('Invalid planType');
  }

  // Validate group number format if provided
  if (data.groupNumber && data.groupNumber.length > 30) {
    errors.push('groupNumber must be 30 characters or less');
  }

  return errors;
}

export default router;
