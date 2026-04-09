import winston from 'winston';

// TODO: ship logs to centralized logging (ELK/Datadog)
// Right now logs just go to stdout which is fine for k8s
// but we lose them after pod recycling

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), winston.format.simple())
  ),
  defaultMeta: { service: 'auth-service' },
  transports: [
    new winston.transports.Console(),
  ],
});
