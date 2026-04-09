import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Patient } from './Patient';

/**
 * Insurance coverage entity.
 *
 * Represents a single insurance coverage record for a patient.
 * Patients can have primary, secondary, and tertiary coverage.
 *
 * Known issues:
 *  - coverageOrder doesn't enforce uniqueness per patient at the DB level (PLAT-7200)
 *  - No proper support for Medicare Part A/B/C/D distinction
 *  - Subscriber info is duplicated when patient is the subscriber
 */
@Entity('insurance_coverages')
@Index(['patient', 'coverageOrder'])
export class Insurance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Patient, (patient) => patient.insuranceCoverages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'patient_id' })
  patient!: Patient;

  // --- Payer Information ---

  @Column({ type: 'varchar', length: 255, name: 'payer_name' })
  payerName!: string;

  /**
   * Payer ID - used for electronic claims submission (EDI 837)
   * This is the payer's NAIC or custom identifier
   */
  @Column({ type: 'varchar', length: 50, name: 'payer_id' })
  payerId!: string;

  @Column({ type: 'varchar', length: 20, name: 'plan_type' })
  planType!: string; // HMO, PPO, EPO, POS, HDHP, Medicare, Medicaid, Tricare, Other

  @Column({ type: 'varchar', length: 255, name: 'plan_name', nullable: true })
  planName?: string;

  // --- Member Information ---

  @Column({ type: 'varchar', length: 50, name: 'member_id' })
  memberId!: string;

  @Column({ type: 'varchar', length: 50, name: 'group_number', nullable: true })
  groupNumber?: string;

  @Column({ type: 'varchar', length: 255, name: 'group_name', nullable: true })
  groupName?: string;

  // --- Subscriber Information ---
  // (subscriber may be different from patient, e.g. child on parent's plan)

  @Column({ type: 'varchar', length: 200, name: 'subscriber_name', nullable: true })
  subscriberName?: string;

  @Column({ type: 'varchar', length: 50, name: 'subscriber_id', nullable: true })
  subscriberId?: string;

  @Column({ type: 'date', name: 'subscriber_dob', nullable: true })
  subscriberDob?: string;

  @Column({ type: 'varchar', length: 30, name: 'relationship_to_subscriber', default: 'self' })
  relationshipToSubscriber!: string; // self, spouse, child, other

  // --- Coverage Details ---

  /**
   * Coverage order: 1 = primary, 2 = secondary, 3 = tertiary
   * Important for coordination of benefits (COB)
   */
  @Column({ type: 'int', name: 'coverage_order', default: 1 })
  coverageOrder!: number;

  @Column({ type: 'date', name: 'start_date' })
  startDate!: string;

  @Column({ type: 'date', name: 'end_date', nullable: true })
  endDate?: string;

  @Column({ type: 'varchar', length: 50, name: 'termination_reason', nullable: true })
  terminationReason?: string;

  // --- Copay/Benefits info ---
  // NOTE: these are just reference values entered by staff
  // Real benefits come from the 271 eligibility response
  // TODO: model this properly with a separate benefits table (PLAT-8100)

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'copay_primary_care', nullable: true })
  copayPrimaryCare?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'copay_specialist', nullable: true })
  copaySpecialist?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'copay_emergency', nullable: true })
  copayEmergency?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  deductible?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'out_of_pocket_max', nullable: true })
  outOfPocketMax?: number;

  // --- Card images ---
  // Front and back of insurance card (stored as S3 keys)
  // HIPAA: insurance cards contain PHI - access must be audited
  @Column({ type: 'varchar', length: 500, name: 'card_front_image_key', nullable: true })
  cardFrontImageKey?: string;

  @Column({ type: 'varchar', length: 500, name: 'card_back_image_key', nullable: true })
  cardBackImageKey?: string;

  // --- Authorization ---

  @Column({ type: 'varchar', length: 50, name: 'prior_auth_phone', nullable: true })
  priorAuthPhone?: string;

  @Column({ type: 'varchar', length: 500, name: 'payer_website', nullable: true })
  payerWebsite?: string;

  // --- Status & Verification ---

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamp', name: 'last_verified_at', nullable: true })
  lastVerifiedAt?: Date;

  @Column({ type: 'varchar', length: 50, name: 'verification_status', nullable: true })
  verificationStatus?: string; // verified, unverified, failed, pending

  // --- Metadata ---

  @Column({ type: 'text', nullable: true })
  notes?: string; // free-text notes from staff

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'varchar', length: 50, name: 'created_by', nullable: true })
  createdBy?: string;

  @Column({ type: 'varchar', length: 50, name: 'updated_by', nullable: true })
  updatedBy?: string;
}
