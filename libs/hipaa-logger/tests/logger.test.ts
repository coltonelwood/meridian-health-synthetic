import { HIPAALogger } from '../src/index';
import { redactSensitiveFields } from '../src/formatters';

describe('HIPAALogger', () => {
  let logger: HIPAALogger;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new HIPAALogger({
      service: 'test-service',
      environment: 'test',
      console: true,
    });
    consoleSpy = jest.spyOn(process.stdout, 'write').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should log info messages', () => {
    expect(() => logger.info('Test message', { key: 'value' })).not.toThrow();
  });

  it('should log audit events', () => {
    expect(() =>
      logger.audit('Patient record accessed', {
        action: 'PHI_ACCESS',
        userId: 'user-123',
        patientId: 'patient-456',
        resource: 'Patient',
        ipAddress: '10.0.0.1',
      })
    ).not.toThrow();
  });

  it('should log PHI access events', () => {
    expect(() =>
      logger.phiAccess({
        action: 'PHI_ACCESS',
        userId: 'user-123',
        patientId: 'patient-456',
        resource: 'Patient',
        ipAddress: '10.0.0.1',
      })
    ).not.toThrow();
  });

  it('should support child loggers', () => {
    const child = logger.child({ requestId: 'req-abc' });
    expect(() => child.info('Test from child')).not.toThrow();
  });
});

describe('redactSensitiveFields', () => {
  const defaultRedactedFields = [
    'ssn',
    'dateOfBirth',
    'password',
    'email',
    'phoneNumber',
    'memberId',
  ];

  it('should redact sensitive field names', () => {
    const input = {
      userId: 'user-123',
      ssn: '123-45-6789',
      name: 'John Doe',
      dateOfBirth: '1990-01-15',
    };

    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.userId).toBe('user-123');
    expect(result.ssn).toBe('[REDACTED]');
    expect(result.name).toBe('John Doe');
    expect(result.dateOfBirth).toBe('[REDACTED]');
  });

  it('should handle case-insensitive field matching', () => {
    const input = { SSN: '123-45-6789', Password: 'secret' };
    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.SSN).toBe('[REDACTED]');
    expect(result.Password).toBe('[REDACTED]');
  });

  it('should handle nested objects', () => {
    const input = {
      patient: {
        id: 'p-123',
        ssn: '123-45-6789',
        demographics: {
          dateOfBirth: '1990-01-15',
          city: 'Boston',
        },
      },
    };

    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.patient.id).toBe('p-123');
    expect(result.patient.ssn).toBe('[REDACTED]');
    expect(result.patient.demographics.dateOfBirth).toBe('[REDACTED]');
    expect(result.patient.demographics.city).toBe('Boston');
  });

  it('should handle arrays', () => {
    const input = {
      patients: [
        { id: 'p-1', ssn: '111-11-1111' },
        { id: 'p-2', ssn: '222-22-2222' },
      ],
    };

    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.patients[0].id).toBe('p-1');
    expect(result.patients[0].ssn).toBe('[REDACTED]');
    expect(result.patients[1].ssn).toBe('[REDACTED]');
  });

  it('should redact PHI patterns in string values', () => {
    const input = {
      message: 'Processing patient with SSN 123-45-6789 at location X',
    };

    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.message).not.toContain('123-45-6789');
    expect(result.message).toContain('[SSN_REDACTED]');
  });

  it('should redact email patterns in string values', () => {
    const input = {
      notes: 'Contact patient at john.doe@example.com',
    };

    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.notes).not.toContain('john.doe@example.com');
    expect(result.notes).toContain('[Email_REDACTED]');
  });

  it('should redact MRN patterns in string values', () => {
    const input = {
      log: 'Updated record MRN-a1b2c3d4 successfully',
    };

    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.log).not.toContain('MRN-a1b2c3d4');
    expect(result.log).toContain('[MRN_v1_REDACTED]');
  });

  it('should handle null and undefined values', () => {
    const input = { ssn: null, password: undefined, name: 'test' };
    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.ssn).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.name).toBe('test');
  });

  it('should handle empty objects', () => {
    expect(redactSensitiveFields({}, defaultRedactedFields)).toEqual({});
  });

  it('should handle fields that partially match redacted names', () => {
    const input = {
      patientMemberId: 'ABC123', // contains "memberId"
      ssnVerified: true, // contains "ssn"
    };

    const result = redactSensitiveFields(input, defaultRedactedFields);

    expect(result.patientMemberId).toBe('[REDACTED]');
    expect(result.ssnVerified).toBe('[REDACTED]');
  });
});
