import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  BeforeInsert,
} from 'typeorm';
import { IsEmail, IsOptional, Length, IsDateString } from 'class-validator';
import { Insurance } from './Insurance';
import { Address } from './Address';

/**
 * Patient entity - core of the patient management system.
 *
 * HIPAA Note: This entity contains Protected Health Information (PHI).
 * All access must be logged via the HIPAA audit middleware.
 * SSN is encrypted at rest using AES-256 (see encryption.ts).
 *
 * See also: HIPAA Security Rule 45 CFR 164.312(a)(2)(iv) - Encryption
 */
@Entity('patients')
@Index(['lastName', 'firstName'])
@Index(['dateOfBirth'])
@Index(['mrn'], { unique: true })
export class Patient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Medical Record Number - unique identifier within our system
   * Format: MRN-XXXXXXXX (auto-generated if not provided)
   */
  @Column({ type: 'varchar', length: 20, unique: true })
  mrn!: string;

  // --- Name fields ---

  @Column({ type: 'varchar', length: 100, name: 'first_name' })
  @Length(1, 100)
  firstName!: string;

  @Column({ type: 'varchar', length: 100, name: 'middle_name', nullable: true })
  @IsOptional()
  middleName?: string;

  @Column({ type: 'varchar', length: 100, name: 'last_name' })
  @Length(1, 100)
  lastName!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  @IsOptional()
  prefix?: string; // Mr., Mrs., Dr., etc.

  @Column({ type: 'varchar', length: 20, nullable: true })
  @IsOptional()
  suffix?: string; // Jr., Sr., III, etc.

  // --- Demographics ---

  @Column({ type: 'date', name: 'date_of_birth' })
  dateOfBirth!: string;

  @Column({ type: 'date', name: 'date_of_death', nullable: true })
  dateOfDeath?: string;

  @Column({ type: 'boolean', name: 'is_deceased', default: false })
  isDeceased!: boolean;

  /**
   * Administrative gender - used for billing and administrative purposes
   * HIPAA: This is required for claims processing
   */
  @Column({
    type: 'varchar',
    length: 20,
    // old values were just M/F/U, updated for ONC 2015 Edition Cures Update
  })
  gender!: string; // male, female, other, unknown

  /**
   * Sex assigned at birth - clinical field
   * Required by ONC USCDI v3
   */
  @Column({ type: 'varchar', length: 50, name: 'sex_assigned_at_birth', nullable: true })
  sexAssignedAtBirth?: string;

  /**
   * Gender identity - SOGI data
   * Required for Meaningful Use Stage 3 / Promoting Interoperability
   */
  @Column({ type: 'varchar', length: 100, name: 'gender_identity', nullable: true })
  genderIdentity?: string;

  /**
   * Sexual orientation - SOGI data
   * Required for Meaningful Use Stage 3 / Promoting Interoperability
   */
  @Column({ type: 'varchar', length: 100, name: 'sexual_orientation', nullable: true })
  sexualOrientation?: string;

  /**
   * SSN - ENCRYPTED AT REST
   * HIPAA Security Rule requires encryption of this field
   * Never return this in API responses without explicit need and audit logging
   * See: encryption.ts for implementation details
   *
   * TODO: implement column-level encryption transformer (PLAT-2890)
   * Right now encryption is handled in the service layer which is not ideal
   */
  @Column({ type: 'varchar', length: 255, name: 'ssn_encrypted', nullable: true })
  ssnEncrypted?: string;

  // Race - using OMB categories + CDC extended race codes
  // Stored as JSON array because patients can identify with multiple races
  @Column({ type: 'jsonb', nullable: true })
  race?: string[];

  // Ethnicity - using OMB categories
  @Column({ type: 'varchar', length: 100, nullable: true })
  ethnicity?: string; // hispanic-or-latino, not-hispanic-or-latino, unknown

  @Column({ type: 'varchar', length: 10, name: 'preferred_language', default: 'en' })
  preferredLanguage!: string;

  @Column({ type: 'varchar', length: 30, name: 'marital_status', nullable: true })
  maritalStatus?: string; // single, married, divorced, widowed, separated, domestic-partner

  @Column({ type: 'varchar', length: 100, nullable: true })
  religion?: string;

  // --- Contact Information ---
  // TODO: these should probably be in a separate contact_info table (PLAT-3102)

  @Column({ type: 'varchar', length: 20, name: 'home_phone', nullable: true })
  homePhone?: string;

  @Column({ type: 'varchar', length: 20, name: 'mobile_phone', nullable: true })
  mobilePhone?: string;

  @Column({ type: 'varchar', length: 20, name: 'work_phone', nullable: true })
  workPhone?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @IsOptional()
  @IsEmail()
  email?: string;

  @Column({ type: 'varchar', length: 20, name: 'preferred_contact_method', default: 'phone' })
  preferredContactMethod!: string; // phone, email, mail, portal

  // --- Emergency Contact ---
  // TODO: support multiple emergency contacts (PLAT-3450)

  @Column({ type: 'varchar', length: 200, name: 'emergency_contact_name', nullable: true })
  emergencyContactName?: string;

  @Column({ type: 'varchar', length: 50, name: 'emergency_contact_relationship', nullable: true })
  emergencyContactRelationship?: string;

  @Column({ type: 'varchar', length: 20, name: 'emergency_contact_phone', nullable: true })
  emergencyContactPhone?: string;

  // --- Clinical Identifiers ---

  @Column({ type: 'varchar', length: 50, name: 'primary_care_provider_id', nullable: true })
  primaryCareProviderId?: string;

  @Column({ type: 'varchar', length: 50, name: 'primary_facility_id', nullable: true })
  primaryFacilityId?: string;

  // --- Status & Metadata ---

  @Column({
    type: 'varchar',
    length: 20,
    default: 'active',
  })
  status!: string; // active, inactive, deceased, merged

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', name: 'merged_into_id', nullable: true })
  mergedIntoId?: string; // if this patient was merged into another

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'varchar', length: 50, name: 'created_by', nullable: true })
  createdBy?: string;

  @Column({ type: 'varchar', length: 50, name: 'updated_by', nullable: true })
  updatedBy?: string;

  // --- Source/Integration tracking ---

  @Column({ type: 'varchar', length: 50, name: 'source_system', nullable: true })
  sourceSystem?: string; // e.g. 'epic', 'cerner', 'manual', 'hl7_adt'

  @Column({ type: 'varchar', length: 255, name: 'external_id', nullable: true })
  externalId?: string; // ID from source system

  // --- Relations ---

  @OneToMany(() => Insurance, (insurance) => insurance.patient, { cascade: true })
  insuranceCoverages?: Insurance[];

  @OneToMany(() => Address, (address) => address.patient, { cascade: true })
  addresses?: Address[];

  // --- Hooks ---

  @BeforeInsert()
  generateMRN() {
    if (!this.mrn) {
      // Generate MRN if not provided
      // Format: MRN-XXXXXXXX
      const randomPart = Math.floor(10000000 + Math.random() * 90000000).toString();
      this.mrn = `MRN-${randomPart}`;
    }
  }

  // helper that was used somewhere but I'm not sure where anymore
  getFullName(): string {
    const parts = [this.prefix, this.firstName, this.middleName, this.lastName, this.suffix];
    return parts.filter(Boolean).join(' ');
  }

  getAge(): number | null {
    if (!this.dateOfBirth) return null;
    const today = new Date();
    const birth = new Date(this.dateOfBirth);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  }
}
