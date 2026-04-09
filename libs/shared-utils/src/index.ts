/**
 * @meridian/shared-utils
 *
 * Shared utility functions used across all Meridian Health services.
 * This package is intentionally kept lightweight with minimal dependencies.
 */

export {
  formatDate,
  parseDate,
  toUTC,
  toTimezone,
  dateRange,
  calculateAge,
  isValidDate,
  daysBetween,
  businessDaysBetween,
} from './dates';

export {
  Money,
  formatCurrency,
  centsToDecimal,
  decimalToCents,
  calculateTax,
  adjustAmount,
} from './money';

export {
  generateMRN,
  validateMRN,
  validateNPI,
  generateClaimNumber,
  validateClaimNumber,
  generateReferralId,
  formatMRN,
} from './identifiers';

export {
  AppError,
  ValidationError,
  NotFoundError,
  AuthorizationError,
  HIPAAViolationError,
  ConflictError,
  ExternalServiceError,
  isAppError,
} from './errors';

export {
  paginate,
  cursorPaginate,
  createPageInfo,
  decodeCursor,
  encodeCursor,
  type PaginationParams,
  type CursorPaginationParams,
  type PageInfo,
  type PaginatedResult,
} from './pagination';
