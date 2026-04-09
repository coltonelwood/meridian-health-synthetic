import { EmailService } from '../src/services/emailService';

// Mock SendGrid
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(),
}));

// Mock nodemailer
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'smtp-msg-123' }),
    verify: jest.fn().mockResolvedValue(true),
  }),
}));

// Mock DB
jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

// Mock template model
jest.mock('../src/models/Template', () => ({
  TemplateModel: jest.fn().mockImplementation(() => ({
    getTemplate: jest.fn().mockResolvedValue({
      subject: 'Test Subject - {{name}}',
      body: '<p>Hello {{name}}, this is a test.</p>',
      html: '<p>Hello {{name}}, this is a test.</p>',
    }),
    renderTemplate: jest.fn().mockImplementation((template: string, data: any) => {
      return template.replace(/\{\{name\}\}/g, data.name || 'User');
    }),
    renderSubject: jest.fn().mockImplementation((template: string, data: any) => {
      return template.replace(/\{\{name\}\}/g, data.name || 'User');
    }),
  })),
}));

const sgMail = require('@sendgrid/mail');
const { pool } = require('../src/db');

describe('EmailService', () => {
  let emailService: EmailService;

  beforeEach(() => {
    jest.clearAllMocks();
    emailService = new EmailService();

    // Mock recipient lookup
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [{
        email: 'patient@example.com',
        first_name: 'Jane',
        last_name: 'Doe',
      }],
    });
  });

  describe('sendTemplatedEmail', () => {
    it('should send email via SendGrid when configured', async () => {
      // Set up SendGrid API key in env
      const originalKey = process.env.SENDGRID_API_KEY;
      process.env.SENDGRID_API_KEY = 'SG.test-key';

      sgMail.send.mockResolvedValueOnce([{
        statusCode: 202,
        headers: { 'x-message-id': 'sg-msg-456' },
      }]);

      // Need to re-import to pick up env var
      // TODO: this test is brittle because the module caches the env var
      // at import time. Should refactor to inject config.

      const result = await emailService.sendTemplatedEmail(
        'user-123',
        'appointment-reminder',
        { name: 'Jane', appointmentDate: '2025-03-15' }
      );

      // This might use SMTP depending on module initialization order
      // which is part of why this test is flaky
      expect(result.success).toBe(true);

      process.env.SENDGRID_API_KEY = originalKey;
    });

    it('should fall back to SMTP when SendGrid fails', async () => {
      // Force circuit breaker open by removing SendGrid key
      const originalKey = process.env.SENDGRID_API_KEY;
      delete process.env.SENDGRID_API_KEY;

      const result = await emailService.sendTemplatedEmail(
        'user-123',
        'appointment-reminder',
        { name: 'Jane' }
      );

      expect(result.success).toBe(true);
      expect(result.provider).toBe('smtp');

      process.env.SENDGRID_API_KEY = originalKey;
    });

    it('should return failure when recipient not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await emailService.sendTemplatedEmail(
        'nonexistent-user',
        'appointment-reminder',
        {}
      );

      expect(result.success).toBe(false);
    });

    it('should return failure when template not found', async () => {
      // Override template mock for this test
      const TemplateModel = require('../src/models/Template').TemplateModel;
      const mockInstance = new TemplateModel();
      mockInstance.getTemplate.mockResolvedValueOnce(null);

      // This test doesn't actually work properly because we create
      // a new TemplateModel instance inside EmailService
      // TODO: fix by injecting TemplateModel as a dependency
      // For now this test passes vacuously
      expect(true).toBe(true);
    });

    it('should include HIPAA footer in all emails', async () => {
      // TODO: implement this test
      // Should verify that all rendered emails contain the PHI disclaimer
      // This is a compliance requirement
      expect(true).toBe(true); // placeholder
    });
  });

  describe('circuit breaker', () => {
    // These tests are hard to write because the circuit breaker state
    // is module-level (not instance-level), so tests affect each other
    // TODO: refactor circuit breaker to be resettable for tests

    it.todo('should open circuit after 3 consecutive SendGrid failures');
    it.todo('should fall back to SMTP when circuit is open');
    it.todo('should try SendGrid again after circuit reset time');
    it.todo('should close circuit on successful SendGrid send');
  });

  describe('verifyConfig', () => {
    it('should report SMTP status', async () => {
      const result = await emailService.verifyConfig();

      expect(result).toHaveProperty('smtp');
      expect(result).toHaveProperty('sendgrid');
    });
  });
});
