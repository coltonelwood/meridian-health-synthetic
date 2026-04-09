import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Patient } from './Patient';

@Entity('patient_addresses')
export class Address {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Patient, (patient) => patient.addresses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'patient_id' })
  patient!: Patient;

  @Column({ type: 'varchar', length: 20, name: 'address_type', default: 'home' })
  addressType!: string; // home, work, temp, billing, old

  @Column({ type: 'varchar', length: 255 })
  line1!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  line2?: string;

  @Column({ type: 'varchar', length: 100 })
  city!: string;

  @Column({ type: 'varchar', length: 2 })
  state!: string; // US state abbreviation - TODO: support international addresses (PLAT-9001)

  @Column({ type: 'varchar', length: 10, name: 'zip_code' })
  zipCode!: string;

  @Column({ type: 'varchar', length: 2, default: 'US' })
  country!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  county?: string; // needed for some state reporting

  @Column({ type: 'boolean', name: 'is_primary', default: false })
  isPrimary!: boolean;

  // Geocoding data - populated by batch job
  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude?: number;

  @Column({ type: 'boolean', name: 'is_geocoded', default: false })
  isGeocoded!: boolean;

  // Period this address was active
  @Column({ type: 'date', name: 'start_date', nullable: true })
  startDate?: string;

  @Column({ type: 'date', name: 'end_date', nullable: true })
  endDate?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
