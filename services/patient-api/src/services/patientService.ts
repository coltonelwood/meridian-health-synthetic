import { getRepository, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Patient } from '../models/Patient';
import { encryptSSN, decryptSSN } from '../utils/encryption';
import { AuthenticatedUser } from '../middleware/auth';

/**
 * Patient service - business logic layer for patient operations.
 *
 * This is supposed to encapsulate all business logic and keep the routes clean.
 * In practice... some logic leaked into the routes because deadlines.
 *
 * TODO: consider splitting this into smaller focused services:
 *   - PatientCrudService
 *   - PatientSearchService
 *   - PatientDuplicateService
 *   - PatientMergeService
 */
export class PatientService {
  private getRepo(): Repository<Patient> {
    return getRepository(Patient);
  }

  /**
   * Get a patient by ID
   */
  async getPatientById(id: string): Promise<Patient | undefined> {
    const repo = this.getRepo();
    const patient = await repo.findOne({
      where: { id, isActive: true },
      relations: ['addresses', 'insuranceCoverages'],
    });
    return patient || undefined;
  }

  /**
   * Get a patient by MRN
   */
  async getPatientByMRN(mrn: string): Promise<Patient | undefined> {
    const repo = this.getRepo();
    const patient = await repo.findOne({
      where: { mrn, isActive: true },
      relations: ['addresses', 'insuranceCoverages'],
    });
    return patient || undefined;
  }

  /**
   * Create a new patient record
   *
   * This method is doing too much and should be broken up, but it works
   * and nobody wants to touch it right now.
   */
  async createPatient(data: any, currentUser: AuthenticatedUser): Promise<Patient> {
    const repo = this.getRepo();

    // Generate MRN if not provided
    let mrn = data.mrn;
    if (!mrn) {
      mrn = await this.generateUniqueMRN();
    }

    // Encrypt SSN if provided
    let ssnEncrypted: string | undefined;
    if (data.ssn) {
      ssnEncrypted = encryptSSN(data.ssn);
    }

    // Build patient entity
    const patient = repo.create({
      mrn,
      firstName: data.firstName.trim(),
      middleName: data.middleName?.trim() || null,
      lastName: data.lastName.trim(),
      prefix: data.prefix || null,
      suffix: data.suffix || null,
      dateOfBirth: data.dateOfBirth,
      gender: data.gender,
      sexAssignedAtBirth: data.sexAssignedAtBirth || null,
      genderIdentity: data.genderIdentity || null,
      sexualOrientation: data.sexualOrientation || null,
      ssnEncrypted,
      race: data.race || null,
      ethnicity: data.ethnicity || null,
      preferredLanguage: data.preferredLanguage || 'en',
      maritalStatus: data.maritalStatus || null,
      religion: data.religion || null,
      homePhone: data.homePhone || null,
      mobilePhone: data.mobilePhone || null,
      workPhone: data.workPhone || null,
      email: data.email || null,
      preferredContactMethod: data.preferredContactMethod || 'phone',
      emergencyContactName: data.emergencyContactName || null,
      emergencyContactRelationship: data.emergencyContactRelationship || null,
      emergencyContactPhone: data.emergencyContactPhone || null,
      primaryCareProviderId: data.primaryCareProviderId || null,
      primaryFacilityId: data.primaryFacilityId || null,
      sourceSystem: data.sourceSystem || 'manual',
      externalId: data.externalId || null,
      status: 'active',
      isActive: true,
      createdBy: currentUser?.userId,
    });

    const saved = await repo.save(patient);

    // Handle addresses if provided
    if (data.addresses && Array.isArray(data.addresses)) {
      // TODO: this should be in a transaction
      const addressRepo = getRepository('Address');
      for (const addr of data.addresses) {
        const address = (addressRepo as any).create({
          ...addr,
          patient: { id: saved.id },
        });
        await (addressRepo as any).save(address);
      }
    }

    // Handle insurance if provided inline
    // (some clients send insurance data with patient creation)
    if (data.insurance && Array.isArray(data.insurance)) {
      const insuranceRepo = getRepository('Insurance');
      for (let i = 0; i < data.insurance.length; i++) {
        const ins = data.insurance[i];
        const coverage = (insuranceRepo as any).create({
          ...ins,
          patient: { id: saved.id },
          coverageOrder: ins.coverageOrder || i + 1,
          createdBy: currentUser?.userId,
        });
        await (insuranceRepo as any).save(coverage);
      }
    }

    // Reload with relations
    const result = await this.getPatientById(saved.id);
    return result!;
  }

  /**
   * Update a patient record
   */
  async updatePatient(id: string, data: any, currentUser: AuthenticatedUser): Promise<Patient> {
    const repo = this.getRepo();

    // Build update object - only include fields that are present
    const updateData: Partial<Patient> = {};

    // Name fields
    if (data.firstName !== undefined) updateData.firstName = data.firstName.trim();
    if (data.middleName !== undefined) updateData.middleName = data.middleName?.trim() || undefined;
    if (data.lastName !== undefined) updateData.lastName = data.lastName.trim();
    if (data.prefix !== undefined) updateData.prefix = data.prefix;
    if (data.suffix !== undefined) updateData.suffix = data.suffix;

    // Demographics
    if (data.dateOfBirth !== undefined) updateData.dateOfBirth = data.dateOfBirth;
    if (data.gender !== undefined) updateData.gender = data.gender;
    if (data.sexAssignedAtBirth !== undefined) updateData.sexAssignedAtBirth = data.sexAssignedAtBirth;
    if (data.genderIdentity !== undefined) updateData.genderIdentity = data.genderIdentity;
    if (data.sexualOrientation !== undefined) updateData.sexualOrientation = data.sexualOrientation;
    if (data.race !== undefined) updateData.race = data.race;
    if (data.ethnicity !== undefined) updateData.ethnicity = data.ethnicity;
    if (data.preferredLanguage !== undefined) updateData.preferredLanguage = data.preferredLanguage;
    if (data.maritalStatus !== undefined) updateData.maritalStatus = data.maritalStatus;
    if (data.religion !== undefined) updateData.religion = data.religion;

    // Contact
    if (data.homePhone !== undefined) updateData.homePhone = data.homePhone;
    if (data.mobilePhone !== undefined) updateData.mobilePhone = data.mobilePhone;
    if (data.workPhone !== undefined) updateData.workPhone = data.workPhone;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.preferredContactMethod !== undefined) updateData.preferredContactMethod = data.preferredContactMethod;

    // Emergency contact
    if (data.emergencyContactName !== undefined) updateData.emergencyContactName = data.emergencyContactName;
    if (data.emergencyContactRelationship !== undefined) updateData.emergencyContactRelationship = data.emergencyContactRelationship;
    if (data.emergencyContactPhone !== undefined) updateData.emergencyContactPhone = data.emergencyContactPhone;

    // Clinical
    if (data.primaryCareProviderId !== undefined) updateData.primaryCareProviderId = data.primaryCareProviderId;
    if (data.primaryFacilityId !== undefined) updateData.primaryFacilityId = data.primaryFacilityId;

    // SSN update
    if (data.ssn !== undefined) {
      updateData.ssnEncrypted = data.ssn ? encryptSSN(data.ssn) : undefined;
    }

    // Status changes
    if (data.isDeceased !== undefined) {
      updateData.isDeceased = data.isDeceased;
      if (data.isDeceased) {
        updateData.status = 'deceased';
        updateData.dateOfDeath = data.dateOfDeath || new Date().toISOString().split('T')[0];
      }
    }

    updateData.updatedBy = currentUser?.userId;
    updateData.updatedAt = new Date();

    await repo.update(id, updateData);

    const updated = await this.getPatientById(id);
    return updated!;
  }

  /**
   * Deactivate (soft-delete) a patient
   */
  async deactivatePatient(id: string, currentUser: AuthenticatedUser): Promise<void> {
    const repo = this.getRepo();
    await repo.update(id, {
      isActive: false,
      status: 'inactive',
      updatedBy: currentUser?.userId,
      updatedAt: new Date(),
    });
  }

  /**
   * Find potential duplicate patients based on name and DOB
   *
   * This is very basic - just exact match on normalized name + DOB.
   * Real duplicate detection would use probabilistic matching with
   * Soundex/Metaphone, Levenshtein distance, etc.
   *
   * TODO: integrate with a proper EMPI (Enterprise Master Patient Index)
   * solution like IBM Initiate or Verato (PLAT-5102)
   */
  async findPotentialDuplicates(
    firstName: string,
    lastName: string,
    dateOfBirth: string
  ): Promise<Patient[]> {
    const repo = this.getRepo();

    const duplicates = await repo
      .createQueryBuilder('patient')
      .where('patient.isActive = :isActive', { isActive: true })
      .andWhere('LOWER(patient.firstName) = LOWER(:firstName)', { firstName: firstName.trim() })
      .andWhere('LOWER(patient.lastName) = LOWER(:lastName)', { lastName: lastName.trim() })
      .andWhere('patient.dateOfBirth = :dob', { dob: dateOfBirth })
      .getMany();

    return duplicates;
  }

  /**
   * Generate a unique MRN
   * Keeps trying until it finds one that doesn't exist
   */
  private async generateUniqueMRN(): Promise<string> {
    const repo = this.getRepo();
    let mrn: string;
    let exists = true;
    let attempts = 0;

    // This is a terrible way to generate unique IDs and will fall over at scale
    // but the sequence-based approach we wanted requires a schema migration
    // that keeps getting deprioritized (PLAT-2001)
    while (exists && attempts < 10) {
      const num = Math.floor(10000000 + Math.random() * 90000000);
      mrn = `MRN-${num}`;
      const existing = await repo.findOne({ where: { mrn } });
      exists = !!existing;
      attempts++;
    }

    if (exists) {
      throw new Error('Failed to generate unique MRN after 10 attempts');
    }

    return mrn!;
  }

  /**
   * Get patient with decrypted SSN
   * Only for authorized use - billing, insurance verification, etc.
   * This is logged separately from normal access
   */
  async getPatientWithSSN(id: string): Promise<Patient & { ssn?: string }> {
    const patient = await this.getPatientById(id);
    if (!patient) {
      throw new Error('Patient not found');
    }

    let ssn: string | undefined;
    if (patient.ssnEncrypted) {
      try {
        ssn = decryptSSN(patient.ssnEncrypted);
      } catch (err) {
        // Log but don't fail - SSN might be corrupted or key rotated
        (global as any).__logger?.error('Failed to decrypt SSN', {
          patientId: id,
          error: (err as Error).message,
        });
      }
    }

    return { ...patient, ssn };
  }

  // ---- Dead code from the old patient matching system ----
  // Kept for reference, might be useful when we implement proper EMPI

  /*
  private calculateMatchScore(patient1: any, patient2: any): number {
    let score = 0;

    // Exact name match
    if (patient1.firstName?.toLowerCase() === patient2.firstName?.toLowerCase()) score += 20;
    if (patient1.lastName?.toLowerCase() === patient2.lastName?.toLowerCase()) score += 20;

    // DOB match
    if (patient1.dateOfBirth === patient2.dateOfBirth) score += 30;

    // SSN match (if available)
    if (patient1.ssn && patient2.ssn && patient1.ssn === patient2.ssn) score += 50;

    // Phone match
    if (patient1.mobilePhone && patient1.mobilePhone === patient2.mobilePhone) score += 15;

    // Address match
    if (patient1.zipCode && patient1.zipCode === patient2.zipCode) score += 5;

    return Math.min(score, 100);
  }
  */
}
