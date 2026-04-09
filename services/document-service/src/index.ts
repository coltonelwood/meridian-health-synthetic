import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import winston from 'winston';

import documentRoutes from './routes/documents';
import templateRoutes from './routes/templates';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3012;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'document-service' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    }),
  ],
});

// Database pool
const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'meridian',
  password: process.env.DB_PASSWORD || 'meridian_dev',
  database: process.env.DB_NAME || 'document_service',
  max: parseInt(process.env.DB_POOL_SIZE || '10'),
  idleTimeoutMillis: 30000,
});

// Multer configuration for file uploads
// Files are stored temporarily on disk, then moved to MinIO/S3
const uploadDir = process.env.UPLOAD_TEMP_DIR || '/tmp/meridian-uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800'), // 50MB default
    files: parseInt(process.env.MAX_FILES_PER_REQUEST || '10'),
  },
  fileFilter: (req, file, cb) => {
    // Allowed MIME types for clinical documents
    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'image/bmp',
      'application/xml',
      'text/xml',
      'application/dicom', // DICOM images
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/html',
      // C-CDA documents
      'application/cda+xml',
      // HL7 messages (yes people still send these as file uploads)
      'application/edi-hl7v2',
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      // We used to reject unknown types but then someone uploaded a .rtf
      // and it broke a clinical workflow, so now we just warn
      logger.warn('Unusual MIME type uploaded', { mimetype: file.mimetype, filename: file.originalname });
      cb(null, true);
      // cb(new Error(`File type ${file.mimetype} is not allowed`), false);
    }
  },
});

(global as any).__pgPool = pgPool;
(global as any).__logger = logger;
(global as any).__upload = upload;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(compression());
// Don't use express.json() globally - multer handles multipart
// and we need raw body access for some document processing
app.use('/api', express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) }
  }));
}

// Health check
app.get('/health', async (req, res) => {
  try {
    await pgPool.query('SELECT 1');
    res.json({
      status: 'healthy',
      version: '1.5.2',
      uptime: process.uptime(),
      storage_backend: process.env.STORAGE_BACKEND || 'local',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
  }
});

app.get('/ready', async (req, res) => {
  try {
    await pgPool.query('SELECT 1');
    // TODO: check MinIO connectivity
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

// Routes
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/templates', templateRoutes);

// 404
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Handle multer errors specifically
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large',
        message: `Maximum file size is ${process.env.MAX_FILE_SIZE || '50MB'}`,
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Too many files',
        message: `Maximum ${process.env.MAX_FILES_PER_REQUEST || 10} files per request`,
      });
    }
  }

  logger.error('Unhandled error in document-service', {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });

  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An error occurred processing your request'
      : err.message,
  });
});

const start = async () => {
  try {
    await pgPool.query('SELECT 1');
    logger.info('Database connected');

    // Ensure local storage directory exists (fallback)
    const localStoragePath = process.env.LOCAL_STORAGE_PATH || '/var/meridian/documents';
    if (!fs.existsSync(localStoragePath)) {
      try {
        fs.mkdirSync(localStoragePath, { recursive: true });
        logger.info('Created local storage directory', { path: localStoragePath });
      } catch (mkdirErr) {
        logger.warn('Could not create local storage directory', { path: localStoragePath });
      }
    }

    app.listen(PORT, () => {
      logger.info(`Document Service started on port ${PORT}`, {
        storageBackend: process.env.STORAGE_BACKEND || 'local',
        maxFileSize: process.env.MAX_FILE_SIZE || '50MB',
      });
    });
  } catch (error: any) {
    logger.error('Failed to start document-service', { error: error.message });
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason });
});

// Cleanup temp files on shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, cleaning up');
  try {
    const tempFiles = fs.readdirSync(uploadDir);
    for (const file of tempFiles) {
      fs.unlinkSync(path.join(uploadDir, file));
    }
    logger.info(`Cleaned up ${tempFiles.length} temp files`);
  } catch (err: any) {
    logger.warn('Failed to cleanup temp files', { error: err.message });
  }
  await pgPool.end();
  process.exit(0);
});

start();

export default app;
