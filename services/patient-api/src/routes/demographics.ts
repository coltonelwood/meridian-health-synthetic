import { Router, Request, Response } from 'express';
import { getRepository } from 'typeorm';
import { Patient } from '../models/Patient';
import { Address } from '../models/Address';

const router = Router();

/**
 * GET /api/v1/demographics/:patientId
 * Get full demographics for a patient
 */
router.get('/:patientId', async (req: Request, res: Response) => {
  try {
    const repo = getRepository(Patient);
    const patient = await repo.findOne({
      where: { id: req.params.patientId, isActive: true },
      relations: ['addresses'],
    });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Build demographics response
    // This format is based on the HL7 ADT spec but we've customized it
    const demographics = {
      patientId: patient.id,
      mrn: patient.mrn,
      name: {
        first: patient.firstName,
        middle: patient.middleName,
        last: patient.lastName,
        suffix: patient.suffix,
        prefix: patient.prefix,
        // TODO: add maiden name field (PLAT-6201)
      },
      dateOfBirth: patient.dateOfBirth,
      gender: patient.gender,
      sex: patient.sexAssignedAtBirth, // added in v2.10 per updated ONC requirements
      genderIdentity: patient.genderIdentity,
      sexualOrientation: patient.sexualOrientation, // SOGI data - required for Meaningful Use Stage 3
      race: patient.race,
      ethnicity: patient.ethnicity,
      preferredLanguage: patient.preferredLanguage,
      maritalStatus: patient.maritalStatus,
      religion: patient.religion,
      addresses: patient.addresses?.map(addr => ({
        id: addr.id,
        type: addr.addressType,
        line1: addr.line1,
        line2: addr.line2,
        city: addr.city,
        state: addr.state,
        zipCode: addr.zipCode,
        country: addr.country,
        isPrimary: addr.isPrimary,
      })),
      contact: {
        homePhone: patient.homePhone,
        mobilePhone: patient.mobilePhone,
        workPhone: patient.workPhone,
        email: patient.email,
        preferredContactMethod: patient.preferredContactMethod,
      },
      emergencyContact: {
        name: patient.emergencyContactName,
        relationship: patient.emergencyContactRelationship,
        phone: patient.emergencyContactPhone,
        // TODO: support multiple emergency contacts (PLAT-3450)
      },
    };

    res.json({ data: demographics });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch demographics', message: error.message });
  }
});

/**
 * PUT /api/v1/demographics/:patientId
 * Update patient demographics
 */
router.put('/:patientId', async (req: Request, res: Response) => {
  try {
    const repo = getRepository(Patient);
    const patient = await repo.findOne({
      where: { id: req.params.patientId, isActive: true },
    });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Map incoming demographics fields to patient entity
    const updateFields: Partial<Patient> = {};

    if (req.body.name) {
      if (req.body.name.first) updateFields.firstName = req.body.name.first;
      if (req.body.name.middle !== undefined) updateFields.middleName = req.body.name.middle;
      if (req.body.name.last) updateFields.lastName = req.body.name.last;
      if (req.body.name.suffix !== undefined) updateFields.suffix = req.body.name.suffix;
      if (req.body.name.prefix !== undefined) updateFields.prefix = req.body.name.prefix;
    }

    if (req.body.gender) updateFields.gender = req.body.gender;
    if (req.body.sex) updateFields.sexAssignedAtBirth = req.body.sex;
    if (req.body.genderIdentity) updateFields.genderIdentity = req.body.genderIdentity;
    if (req.body.sexualOrientation) updateFields.sexualOrientation = req.body.sexualOrientation;
    if (req.body.race) updateFields.race = req.body.race;
    if (req.body.ethnicity) updateFields.ethnicity = req.body.ethnicity;
    if (req.body.preferredLanguage) updateFields.preferredLanguage = req.body.preferredLanguage;
    if (req.body.maritalStatus) updateFields.maritalStatus = req.body.maritalStatus;
    if (req.body.religion !== undefined) updateFields.religion = req.body.religion;

    // Contact info
    if (req.body.contact) {
      if (req.body.contact.homePhone !== undefined) updateFields.homePhone = req.body.contact.homePhone;
      if (req.body.contact.mobilePhone !== undefined) updateFields.mobilePhone = req.body.contact.mobilePhone;
      if (req.body.contact.workPhone !== undefined) updateFields.workPhone = req.body.contact.workPhone;
      if (req.body.contact.email !== undefined) updateFields.email = req.body.contact.email;
      if (req.body.contact.preferredContactMethod) updateFields.preferredContactMethod = req.body.contact.preferredContactMethod;
    }

    // Emergency contact
    if (req.body.emergencyContact) {
      if (req.body.emergencyContact.name !== undefined) updateFields.emergencyContactName = req.body.emergencyContact.name;
      if (req.body.emergencyContact.relationship !== undefined) updateFields.emergencyContactRelationship = req.body.emergencyContact.relationship;
      if (req.body.emergencyContact.phone !== undefined) updateFields.emergencyContactPhone = req.body.emergencyContact.phone;
    }

    updateFields.updatedAt = new Date();
    updateFields.updatedBy = (req as any).user?.userId;

    await repo.update(req.params.patientId, updateFields);

    const updated = await repo.findOne({
      where: { id: req.params.patientId },
      relations: ['addresses'],
    });

    res.json({ data: updated, message: 'Demographics updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update demographics', message: error.message });
  }
});

/**
 * POST /api/v1/demographics/:patientId/addresses
 * Add an address to a patient
 */
router.post('/:patientId/addresses', async (req: Request, res: Response) => {
  try {
    const patientRepo = getRepository(Patient);
    const patient = await patientRepo.findOne({
      where: { id: req.params.patientId, isActive: true },
    });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const addressRepo = getRepository(Address);

    // If this is set as primary, unset other primary addresses
    if (req.body.isPrimary) {
      await addressRepo.update(
        { patient: { id: req.params.patientId }, isPrimary: true },
        { isPrimary: false }
      );
    }

    const address = addressRepo.create({
      ...req.body,
      patient: { id: req.params.patientId },
    });

    const saved = await addressRepo.save(address);
    res.status(201).json({ data: saved });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to add address', message: error.message });
  }
});

/**
 * PUT /api/v1/demographics/:patientId/addresses/:addressId
 * Update a patient address
 */
router.put('/:patientId/addresses/:addressId', async (req: Request, res: Response) => {
  try {
    const addressRepo = getRepository(Address);
    const address = await addressRepo.findOne({
      where: {
        id: req.params.addressId,
        patient: { id: req.params.patientId },
      },
    });

    if (!address) {
      return res.status(404).json({ error: 'Address not found' });
    }

    // Handle primary address toggle
    if (req.body.isPrimary && !address.isPrimary) {
      await addressRepo.update(
        { patient: { id: req.params.patientId }, isPrimary: true },
        { isPrimary: false }
      );
    }

    await addressRepo.update(req.params.addressId, req.body);
    const updated = await addressRepo.findOne({ where: { id: req.params.addressId } });

    res.json({ data: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update address', message: error.message });
  }
});

/**
 * DELETE /api/v1/demographics/:patientId/addresses/:addressId
 * Remove a patient address
 */
router.delete('/:patientId/addresses/:addressId', async (req: Request, res: Response) => {
  // TODO: should we soft-delete addresses too? Check with compliance team
  try {
    const addressRepo = getRepository(Address);
    const address = await addressRepo.findOne({
      where: {
        id: req.params.addressId,
        patient: { id: req.params.patientId },
      },
    });

    if (!address) {
      return res.status(404).json({ error: 'Address not found' });
    }

    await addressRepo.remove(address);
    res.status(200).json({ message: 'Address removed' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to remove address', message: error.message });
  }
});

/**
 * GET /api/v1/demographics/stats/languages
 * Get aggregate language statistics (for reporting)
 */
router.get('/stats/languages', async (req: Request, res: Response) => {
  // TODO: partially implemented, need to add date range filtering
  try {
    const repo = getRepository(Patient);
    const stats = await repo
      .createQueryBuilder('patient')
      .select('patient.preferredLanguage', 'language')
      .addSelect('COUNT(*)', 'count')
      .where('patient.isActive = true')
      .groupBy('patient.preferredLanguage')
      .orderBy('count', 'DESC')
      .getRawMany();

    res.json({ data: stats });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch language stats' });
  }
});

/**
 * GET /api/v1/demographics/stats/race-ethnicity
 * Get aggregate race/ethnicity statistics (for CMS reporting)
 */
router.get('/stats/race-ethnicity', async (req: Request, res: Response) => {
  // TODO: implement this - needed for CMS quality reporting
  // Need to figure out the right grouping categories
  res.status(501).json({
    error: 'Not Implemented',
    message: 'Race/ethnicity statistics endpoint is under development',
  });
});

export default router;
