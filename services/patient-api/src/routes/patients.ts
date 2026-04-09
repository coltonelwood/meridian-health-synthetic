import { Router, Request, Response, NextFunction } from 'express';
import { getRepository, Like, In } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Patient } from '../models/Patient';
import { PatientService } from '../services/patientService';
import { mapToFhirPatient } from '../services/fhirMapper';
import { validatePatientInput, validateMRN } from '../utils/validators';

const router = Router();
const patientService = new PatientService();

/**
 * GET /api/v1/patients
 * List patients with optional search/filter
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      search,
      lastName,
      firstName,
      mrn,
      dob,
      status,
      page = '1',
      limit = '25',
      // sort, // TODO: implement sorting (PLAT-3892)
      // fields, // TODO: implement field selection for performance
    } = req.query;

    const pageNum = parseInt(page as string) || 1;
    const limitNum = Math.min(parseInt(limit as string) || 25, 100); // cap at 100
    const offset = (pageNum - 1) * limitNum;

    // TODO: this is getting unwieldy, move to a query builder class
    const repo = getRepository(Patient);
    let queryBuilder = repo.createQueryBuilder('patient')
      .where('patient.isActive = :isActive', { isActive: true });

    if (search) {
      // Full-text search across multiple fields
      // TODO: switch to Elasticsearch for better search (PLAT-2341)
      queryBuilder = queryBuilder.andWhere(
        '(patient.firstName ILIKE :search OR patient.lastName ILIKE :search OR patient.mrn ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    if (lastName) {
      queryBuilder = queryBuilder.andWhere('patient.lastName ILIKE :lastName', { lastName: `%${lastName}%` });
    }

    if (firstName) {
      queryBuilder = queryBuilder.andWhere('patient.firstName ILIKE :firstName', { firstName: `%${firstName}%` });
    }

    if (mrn) {
      queryBuilder = queryBuilder.andWhere('patient.mrn = :mrn', { mrn });
    }

    if (dob) {
      queryBuilder = queryBuilder.andWhere('patient.dateOfBirth = :dob', { dob });
    }

    if (status) {
      queryBuilder = queryBuilder.andWhere('patient.status = :status', { status });
    }

    const [patients, total] = await queryBuilder
      .orderBy('patient.lastName', 'ASC')
      .addOrderBy('patient.firstName', 'ASC')
      .skip(offset)
      .take(limitNum)
      .getManyAndCount();

    // Check Accept header for FHIR format
    const acceptHeader = req.headers['accept'] || '';
    if (acceptHeader.includes('application/fhir+json')) {
      // Return FHIR Bundle
      const bundle = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: total,
        link: [
          {
            relation: 'self',
            url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
          },
          // TODO: add next/prev pagination links
        ],
        entry: patients.map(p => ({
          fullUrl: `${req.protocol}://${req.get('host')}/api/v1/patients/${p.id}`,
          resource: mapToFhirPatient(p),
          search: { mode: 'match' },
        })),
      };
      return res.json(bundle);
    }

    res.json({
      data: patients,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error: any) {
    console.error('Error fetching patients:', error); // TODO: use logger
    res.status(500).json({ error: 'Failed to fetch patients', message: error.message });
  }
});

/**
 * GET /api/v1/patients/:id
 * Get a single patient by ID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const patient = await patientService.getPatientById(req.params.id);

    if (!patient) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Patient with ID ${req.params.id} not found`,
      });
    }

    // FHIR format support
    if (req.headers['accept']?.includes('application/fhir+json')) {
      return res.json(mapToFhirPatient(patient));
    }

    res.json({ data: patient });
  } catch (error: any) {
    // if it's a UUID format error, it's a 400 not 500
    if (error.message?.includes('invalid input syntax for type uuid')) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid patient ID format' });
    }
    res.status(500).json({ error: 'Failed to fetch patient', message: error.message });
  }
});

/**
 * GET /api/v1/patients/mrn/:mrn
 * Look up patient by MRN
 */
router.get('/mrn/:mrn', async (req: Request, res: Response) => {
  const { mrn } = req.params;

  if (!validateMRN(mrn)) {
    return res.status(400).json({ error: 'Invalid MRN format' });
  }

  // using .then() here because this was written before we adopted async/await consistently
  // TODO: refactor to async/await (low priority)
  patientService.getPatientByMRN(mrn)
    .then(patient => {
      if (!patient) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Patient with MRN ${mrn} not found`,
        });
      }
      res.json({ data: patient });
    })
    .catch(error => {
      res.status(500).json({ error: 'Failed to fetch patient', message: error.message });
    });
});

/**
 * POST /api/v1/patients
 * Create a new patient
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const validationErrors = validatePatientInput(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationErrors,
      });
    }

    // Check for duplicate MRN
    if (req.body.mrn) {
      const existing = await patientService.getPatientByMRN(req.body.mrn);
      if (existing) {
        return res.status(409).json({
          error: 'Conflict',
          message: `Patient with MRN ${req.body.mrn} already exists`,
          existingPatientId: existing.id,
        });
      }
    }

    // Check for potential duplicate patient (same name + DOB)
    // TODO: this duplicate detection is too simplistic, need probabilistic matching (PLAT-5102)
    const potentialDuplicates = await patientService.findPotentialDuplicates(
      req.body.firstName,
      req.body.lastName,
      req.body.dateOfBirth
    );

    if (potentialDuplicates.length > 0 && !req.body.confirmNotDuplicate) {
      return res.status(409).json({
        error: 'Potential Duplicate',
        message: 'A patient with similar information already exists',
        potentialMatches: potentialDuplicates.map(p => ({
          id: p.id,
          mrn: p.mrn,
          firstName: p.firstName,
          lastName: p.lastName,
          dateOfBirth: p.dateOfBirth,
        })),
        instruction: 'Set confirmNotDuplicate=true to proceed',
      });
    }

    const patient = await patientService.createPatient(req.body, (req as any).user);

    res.status(201).json({
      data: patient,
      message: 'Patient created successfully',
    });
  } catch (error: any) {
    (global as any).__logger?.error('Error creating patient', { error: error.message });
    res.status(500).json({ error: 'Failed to create patient', message: error.message });
  }
});

/**
 * PUT /api/v1/patients/:id
 * Update a patient
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const patient = await patientService.getPatientById(req.params.id);
    if (!patient) {
      return res.status(404).json({ error: 'Not Found' });
    }

    const validationErrors = validatePatientInput(req.body, true); // true = partial update
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationErrors,
      });
    }

    const updated = await patientService.updatePatient(req.params.id, req.body, (req as any).user);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update patient', message: error.message });
  }
});

/**
 * PATCH /api/v1/patients/:id
 * Partial update a patient
 */
router.patch('/:id', async (req: Request, res: Response) => {
  // TODO: PATCH and PUT do basically the same thing right now
  // need to properly differentiate them
  try {
    const patient = await patientService.getPatientById(req.params.id);
    if (!patient) {
      return res.status(404).json({ error: 'Not Found' });
    }

    const updated = await patientService.updatePatient(req.params.id, req.body, (req as any).user);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update patient', message: error.message });
  }
});

/**
 * DELETE /api/v1/patients/:id
 * Soft-delete a patient (we never hard-delete patient records - HIPAA retention requirements)
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const patient = await patientService.getPatientById(req.params.id);
    if (!patient) {
      return res.status(404).json({ error: 'Not Found' });
    }

    // Soft delete
    await patientService.deactivatePatient(req.params.id, (req as any).user);

    res.status(200).json({
      message: 'Patient deactivated successfully',
      // note: patient data retained per HIPAA requirements
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to deactivate patient', message: error.message });
  }
});

/**
 * POST /api/v1/patients/:id/merge
 * Merge two patient records (e.g., duplicate resolution)
 */
router.post('/:id/merge', async (req: Request, res: Response) => {
  // TODO: implement patient merge (PLAT-4890)
  // This is complex - need to handle:
  // - Insurance records
  // - Encounter history
  // - Lab results
  // - Medication lists
  // - Audit trail
  res.status(501).json({
    error: 'Not Implemented',
    message: 'Patient merge is not yet implemented. Use the admin portal for now.',
  });
});

/**
 * POST /api/v1/patients/batch
 * Batch import patients (e.g. from EHR migration)
 */
router.post('/batch', async (req: Request, res: Response) => {
  const { patients } = req.body;

  if (!Array.isArray(patients) || patients.length === 0) {
    return res.status(400).json({ error: 'Request body must contain a non-empty patients array' });
  }

  if (patients.length > 500) {
    return res.status(400).json({
      error: 'Batch size too large',
      message: 'Maximum 500 patients per batch. Use the async import endpoint for larger datasets.',
    });
  }

  // TODO: this should be async with a job queue for large batches
  // For now just process synchronously which is... not great
  const results = {
    created: [] as any[],
    errors: [] as any[],
    duplicates: [] as any[],
  };

  for (let i = 0; i < patients.length; i++) {
    try {
      const validationErrors = validatePatientInput(patients[i]);
      if (validationErrors.length > 0) {
        results.errors.push({ index: i, errors: validationErrors });
        continue;
      }

      const patient = await patientService.createPatient(patients[i], (req as any).user);
      results.created.push({ index: i, id: patient.id, mrn: patient.mrn });
    } catch (error: any) {
      if (error.message?.includes('duplicate')) {
        results.duplicates.push({ index: i, error: error.message });
      } else {
        results.errors.push({ index: i, error: error.message });
      }
    }
  }

  const statusCode = results.errors.length > 0 ? 207 : 201; // 207 Multi-Status if partial failure
  res.status(statusCode).json({
    data: results,
    summary: {
      total: patients.length,
      created: results.created.length,
      errors: results.errors.length,
      duplicates: results.duplicates.length,
    },
  });
});

// Dead code - was used for the old search endpoint before we unified it into GET /
// Keeping it around in case we need to reference the old approach
/*
router.post('/search', async (req: Request, res: Response) => {
  const { criteria, pagination } = req.body;
  const repo = getRepository(Patient);

  let query = repo.createQueryBuilder('patient');

  if (criteria.name) {
    query = query.where(
      "CONCAT(patient.firstName, ' ', patient.lastName) ILIKE :name",
      { name: `%${criteria.name}%` }
    );
  }

  if (criteria.dobRange) {
    query = query.andWhere('patient.dateOfBirth BETWEEN :start AND :end', {
      start: criteria.dobRange.start,
      end: criteria.dobRange.end,
    });
  }

  if (criteria.insuranceProvider) {
    query = query.leftJoinAndSelect('patient.insuranceCoverages', 'insurance')
      .andWhere('insurance.payerName ILIKE :payer', { payer: `%${criteria.insuranceProvider}%` });
  }

  const [results, count] = await query
    .skip(pagination?.offset || 0)
    .take(pagination?.limit || 25)
    .getManyAndCount();

  res.json({ data: results, total: count });
});
*/

export default router;
