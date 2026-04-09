import { uploadFile, downloadFile, deleteFile, fileExists, getPresignedUrl } from '../src/services/storageService';
import fs from 'fs';
import path from 'path';

// Mock MinIO client
const mockPutObject = jest.fn().mockResolvedValue({});
const mockGetObject = jest.fn();
const mockRemoveObject = jest.fn().mockResolvedValue({});
const mockBucketExists = jest.fn().mockResolvedValue(true);
const mockMakeBucket = jest.fn().mockResolvedValue({});
const mockStatObject = jest.fn();
const mockPresignedGetObject = jest.fn().mockResolvedValue('https://minio.example.com/presigned-url');

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => ({
    putObject: mockPutObject,
    getObject: mockGetObject,
    removeObject: mockRemoveObject,
    bucketExists: mockBucketExists,
    makeBucket: mockMakeBucket,
    statObject: mockStatObject,
    presignedGetObject: mockPresignedGetObject,
  })),
}));

// Mock fs
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    createReadStream: jest.fn().mockReturnValue({ pipe: jest.fn() }),
    statSync: jest.fn().mockReturnValue({ size: 1024 }),
    existsSync: jest.fn().mockReturnValue(true),
    copyFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn().mockReturnValue(Buffer.from('test content')),
  };
});

// Mock logger
(global as any).__logger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

describe('storageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STORAGE_BACKEND = 'minio';
    process.env.MINIO_BUCKET = 'test-bucket';
  });

  afterEach(() => {
    delete process.env.STORAGE_BACKEND;
    delete process.env.MINIO_BUCKET;
  });

  describe('uploadFile', () => {
    it('should upload to MinIO when backend is minio', async () => {
      const result = await uploadFile(
        'documents/patient-1/test.pdf',
        '/tmp/upload-123',
        'application/pdf',
        'test-bucket'
      );

      expect(mockBucketExists).toHaveBeenCalledWith('test-bucket');
      expect(mockPutObject).toHaveBeenCalled();
      expect(result.backend).toBe('minio');
      expect(result.key).toBe('documents/patient-1/test.pdf');
    });

    it('should create bucket if it does not exist', async () => {
      mockBucketExists.mockResolvedValueOnce(false);

      await uploadFile(
        'documents/test.pdf',
        '/tmp/upload-456',
        'application/pdf',
        'new-bucket'
      );

      expect(mockMakeBucket).toHaveBeenCalledWith('new-bucket', expect.any(String));
    });

    it('should fall back to local storage when MinIO fails', async () => {
      mockPutObject.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await uploadFile(
        'documents/test.pdf',
        '/tmp/upload-789',
        'application/pdf'
      );

      expect(result.backend).toBe('local');
      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    it('should upload to local storage when backend is local', async () => {
      process.env.STORAGE_BACKEND = 'local';

      const result = await uploadFile(
        'documents/test.pdf',
        '/tmp/upload-abc',
        'application/pdf'
      );

      expect(result.backend).toBe('local');
      expect(mockPutObject).not.toHaveBeenCalled();
    });
  });

  describe('downloadFile', () => {
    it('should download from MinIO', async () => {
      const mockStream = { pipe: jest.fn() };
      mockGetObject.mockResolvedValueOnce(mockStream);

      const result = await downloadFile('minio', 'documents/test.pdf', 'test-bucket');

      expect(mockGetObject).toHaveBeenCalledWith('test-bucket', 'documents/test.pdf');
      expect(result).toBe(mockStream);
    });

    it('should fall back to local when MinIO download fails', async () => {
      mockGetObject.mockRejectedValueOnce(new Error('Not found'));
      (fs.existsSync as jest.Mock).mockReturnValueOnce(true);

      const result = await downloadFile('minio', 'documents/test.pdf', 'test-bucket');

      // Should return local file path as string
      expect(typeof result).toBe('string');
    });

    it('should throw when file not found in any backend', async () => {
      mockGetObject.mockRejectedValueOnce(new Error('Not found'));
      (fs.existsSync as jest.Mock).mockReturnValueOnce(false);

      await expect(
        downloadFile('minio', 'documents/nonexistent.pdf', 'test-bucket')
      ).rejects.toThrow('File not found');
    });

    it('should download from local filesystem', async () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(true);

      const result = await downloadFile('local', 'documents/test.pdf');

      expect(typeof result).toBe('string');
      expect(mockGetObject).not.toHaveBeenCalled();
    });

    it('should throw when local file not found', async () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(false);

      await expect(
        downloadFile('local', 'documents/nonexistent.pdf')
      ).rejects.toThrow('File not found');
    });
  });

  describe('deleteFile', () => {
    it('should delete from MinIO', async () => {
      await deleteFile('minio', 'documents/test.pdf', 'test-bucket');

      expect(mockRemoveObject).toHaveBeenCalledWith('test-bucket', 'documents/test.pdf');
    });

    it('should delete from local filesystem', async () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(true);

      await deleteFile('local', 'documents/test.pdf');

      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  describe('fileExists', () => {
    it('should check MinIO for file existence', async () => {
      mockStatObject.mockResolvedValueOnce({});

      const exists = await fileExists('minio', 'documents/test.pdf', 'test-bucket');

      expect(exists).toBe(true);
    });

    it('should return false when MinIO stat fails', async () => {
      mockStatObject.mockRejectedValueOnce(new Error('Not found'));

      const exists = await fileExists('minio', 'documents/nonexistent.pdf', 'test-bucket');

      expect(exists).toBe(false);
    });

    it('should check local filesystem', async () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(true);

      const exists = await fileExists('local', 'documents/test.pdf');

      expect(exists).toBe(true);
    });
  });

  describe('getPresignedUrl', () => {
    it('should generate presigned URL', async () => {
      const url = await getPresignedUrl('documents/test.pdf', 'test-bucket', 3600);

      expect(url).toBe('https://minio.example.com/presigned-url');
      expect(mockPresignedGetObject).toHaveBeenCalledWith(
        'test-bucket', 'documents/test.pdf', 3600
      );
    });

    it('should return null on error', async () => {
      mockPresignedGetObject.mockRejectedValueOnce(new Error('Failed'));

      const url = await getPresignedUrl('documents/test.pdf');

      expect(url).toBeNull();
    });
  });

  // TODO: test concurrent uploads
  // TODO: test with very large files
  // TODO: test retry behavior when MinIO is intermittently unavailable
});
