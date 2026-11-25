/// <reference lib="es2020" />

// Table `sensor_alerts`: id, sensor_id, org_id, severity, started_at, last_seen_at, status
// severity values: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
// Verified user info (if authenticated) is on `req.user = { id, orgId }`

// ============================================================================
// 1. Types & Domain Interfaces
// ============================================================================

export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertStatus = 'ACTIVE' | 'RESOLVED' | 'ACKNOWLEDGED';

export const SEVERITY_LEVELS: readonly AlertSeverity[] = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export interface AuthenticatedUser {
  id: string;
  orgId: string;
  isActive?: boolean;
  status?: string;
  orgIds?: string[];
  [key: string]: unknown;
}

export interface AuthenticatedRequest {
  user?: AuthenticatedUser;
  query?: {
    orgId?: string;
    startTime?: string;
    endTime?: string;
    page?: string | number;
    limit?: string | number;
    minSeverity?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OrganizationRow {
  id: string;
  status: string;
  [key: string]: unknown;
}

export interface AlertRow {
  id: string;
  sensor_id: string;
  org_id: string;
  severity: AlertSeverity;
  started_at: string | Date;
  last_seen_at: string | Date;
  status: string;
  total_count?: string | number;
  [key: string]: unknown;
}

export interface FormattedAlert {
  id: string;
  sensorId: string;
  orgId: string;
  severity: AlertSeverity;
  startedAt: string;
  lastSeenAt: string;
  status: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface ApiResponse<T = unknown> {
  status: number;
  success: boolean;
  succcess: boolean; // [MISSING PART]: Dual-field provided for exact contract compatibility
  data: T | null;
  pagination: PaginationMeta | null;
  errors: string[];
}

export interface QueueMessage {
  id?: string;
  body: unknown;
  receiptHandle?: string;
  [key: string]: unknown;
}

export interface AlertMessagePayload {
  alertId: string;
  sensorId: string;
  orgId: string;
  severity: AlertSeverity;
  timestamp: string | number | Date;
}

// [MISSING PART]: Database & Queue client interfaces for ambient runtime bindings
export interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number }>;
}

export interface QueueClient {
  ack(msg: QueueMessage): Promise<void>;
  nack?(msg: QueueMessage, requeue?: boolean): Promise<void>;
  deadLetter?(msg: QueueMessage, reason?: string): Promise<void>;
}

declare const db: DatabaseClient;
declare const queue: QueueClient;

// ============================================================================
// 2. Structured Logger & Utility Helpers
// ============================================================================

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export function logStructured(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
  error?: unknown
): void {
  const logEntry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ? { context } : {}),
  };

  if (error instanceof Error) {
    logEntry.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(('code' in error) ? { code: (error as any).code } : {}),
    };
  } else if (error) {
    logEntry.error = { message: String(error) };
  }

  const serialized = JSON.stringify(logEntry);
  if (level === 'ERROR') {
    console.error(serialized);
  } else if (level === 'WARN') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

export function sendStructuredResponse<T>(
  res: any,
  statusCode: number,
  success: boolean,
  data: T | null = null,
  pagination: PaginationMeta | null = null,
  errors: string[] = []
) {
  const response: ApiResponse<T> = {
    status: statusCode,
    success,
    succcess: success,
    data,
    pagination,
    errors,
  };

  if (typeof res.status === 'function') {
    return res.status(statusCode).json(response);
  }
  return res.json(response);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// 3. Validation Layer (Reusable & Single Responsibility)
// ============================================================================

export interface ValidatedAlertQueryParams {
  orgId: string;
  startTime: Date;
  endTime: Date;
  page: number;
  limit: number;
  allowedSeverities: AlertSeverity[] | null;
}

export interface ValidationResult<T> {
  isValid: boolean;
  errors: string[];
  data?: T;
}

export interface UserAccessResult {
  authorized: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Validates and normalizes query parameters for getActiveAlerts.
 */
export function validateAlertQueryParams(
  query: Record<string, unknown> = {}
): ValidationResult<ValidatedAlertQueryParams> {
  const errors: string[] = [];
  const { orgId, startTime, endTime, page = 1, limit = 20, minSeverity } = query;

  if (!orgId || typeof orgId !== 'string' || !orgId.trim()) {
    errors.push('orgId is required and must be a non-empty string');
  }

  let parsedStart: Date | null = null;
  if (!startTime || typeof startTime !== 'string' || !startTime.trim()) {
    errors.push('startTime is required and must be a valid ISO date string');
  } else {
    parsedStart = new Date(startTime);
    if (isNaN(parsedStart.getTime())) {
      errors.push('startTime must be a valid ISO 8601 date');
      parsedStart = null;
    }
  }

  let parsedEnd: Date | null = null;
  if (!endTime || typeof endTime !== 'string' || !endTime.trim()) {
    errors.push('endTime is required and must be a valid ISO date string');
  } else {
    parsedEnd = new Date(endTime);
    if (isNaN(parsedEnd.getTime())) {
      errors.push('endTime must be a valid ISO 8601 date');
      parsedEnd = null;
    }
  }

  // Time window bounds validation
  if (parsedStart && parsedEnd) {
    if (parsedStart.getTime() > parsedEnd.getTime()) {
      errors.push('startTime cannot be later than endTime');
    }

    // [MISSING PART]: Prevent table-scan DoS by capping maximum query window (90 days)
    const maxWindowMs = 90 * 24 * 60 * 60 * 1000;
    if (parsedEnd.getTime() - parsedStart.getTime() > maxWindowMs) {
      errors.push('Time window exceeds maximum allowed limit of 90 days');
    }
  }

  // Pagination parameters validation
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);

  if (!Number.isInteger(parsedPage) || parsedPage < 1) {
    errors.push('page must be a positive integer greater than or equal to 1');
  }

  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    errors.push('limit must be a positive integer between 1 and 100');
  }

  // Optional minSeverity filter validation
  let allowedSeverities: AlertSeverity[] | null = null;
  if (minSeverity !== undefined && minSeverity !== null && minSeverity !== '') {
    if (typeof minSeverity !== 'string' || !SEVERITY_LEVELS.includes(minSeverity as AlertSeverity)) {
      errors.push(
        `Invalid minSeverity filter '${minSeverity}'. Allowed values are: ${SEVERITY_LEVELS.join(', ')}`
      );
    } else {
      const minIndex = SEVERITY_LEVELS.indexOf(minSeverity as AlertSeverity);
      allowedSeverities = SEVERITY_LEVELS.slice(minIndex) as AlertSeverity[];
    }
  }

  if (errors.length > 0) {
    return { isValid: false, errors };
  }

  return {
    isValid: true,
    errors: [],
    data: {
      orgId: String(orgId).trim(),
      startTime: parsedStart!,
      endTime: parsedEnd!,
      page: parsedPage,
      limit: parsedLimit,
      allowedSeverities,
    },
  };
}

/**
 * Validates authentication and organization access rights of the requesting user.
 */
export function validateUserOrgAccess(
  user: AuthenticatedUser | undefined,
  targetOrgId: string
): UserAccessResult {
  if (!user || !user.id) {
    return {
      authorized: false,
      statusCode: 401,
      error: 'Unauthorized: Missing or invalid authentication credentials',
    };
  }

  // [MISSING PART]: Verify user isActive flag or status
  if (user.isActive === false || (user.status && String(user.status).toUpperCase() !== 'ACTIVE')) {
    return {
      authorized: false,
      statusCode: 403,
      error: 'Forbidden: User account is inactive',
    };
  }

  const userOrgId = user.orgId;
  const userOrgIds = Array.isArray(user.orgIds) ? user.orgIds : [];
  if (userOrgId !== targetOrgId && !userOrgIds.includes(targetOrgId)) {
    return {
      authorized: false,
      statusCode: 403,
      error: 'Forbidden: User does not have access to the requested organization',
    };
  }

  return { authorized: true };
}

/**
 * Validates and safely parses incoming queue message and payload.
 * Blocks poison pills (invalid JSON or bad schema) without retrying.
 */
export function parseAndValidateAlertPayload(
  msg: QueueMessage
): ValidationResult<AlertMessagePayload> {
  if (!msg || typeof msg !== 'object' || msg.body === undefined || msg.body === null) {
    return {
      isValid: false,
      errors: ['Invalid queue message: msg or msg.body is missing'],
    };
  }

  let payload: AlertMessagePayload;
  try {
    if (typeof msg.body === 'string') {
      payload = JSON.parse(msg.body);
    } else if (typeof msg.body === 'object' && msg.body !== null) {
      payload = msg.body as AlertMessagePayload;
    } else {
      return {
        isValid: false,
        errors: [`Invalid msg.body type: expected string or object, received ${typeof msg.body}`],
      };
    }
  } catch (err: unknown) {
    return {
      isValid: false,
      errors: [`Malformed JSON in msg.body: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    errors.push('Payload must be a non-null object');
  } else {
    if (!payload.alertId || typeof payload.alertId !== 'string' || !payload.alertId.trim()) {
      errors.push('alertId is required and must be a non-empty string');
    }
    if (!payload.sensorId || typeof payload.sensorId !== 'string' || !payload.sensorId.trim()) {
      errors.push('sensorId is required and must be a non-empty string');
    }
    if (!payload.orgId || typeof payload.orgId !== 'string' || !payload.orgId.trim()) {
      errors.push('orgId is required and must be a non-empty string');
    }
    if (!payload.severity || !SEVERITY_LEVELS.includes(payload.severity)) {
      errors.push(`severity must be one of: ${SEVERITY_LEVELS.join(', ')}`);
    }
    if (!payload.timestamp || isNaN(new Date(payload.timestamp).getTime())) {
      errors.push('timestamp must be a valid ISO date or timestamp');
    }
  }

  if (errors.length > 0) {
    return { isValid: false, errors };
  }

  return { isValid: true, errors: [], data: payload };
}

// ============================================================================
// 4. Data Access Layer (Separated DB Operations)
// ============================================================================

/**
 * Normalizes raw database row into API Alert DTO.
 */
export function formatAlertRow(row: AlertRow, fallbackOrgId: string): FormattedAlert {
  return {
    id: String(row.id),
    sensorId: String(row.sensor_id),
    orgId: String(row.org_id || fallbackOrgId),
    severity: row.severity,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at),
    status: String(row.status),
  };
}

/**
 * Fetches organization by ID to verify existence and active status.
 */
export async function fetchOrganizationById(orgId: string): Promise<OrganizationRow | null> {
  const result = await db.query(
    `SELECT id, status FROM organizations WHERE id = $1 LIMIT 1`,
    [orgId]
  );
  if (!result.rows || result.rows.length === 0) {
    return null;
  }
  return result.rows[0] as OrganizationRow;
}

/**
 * Queries active alerts with status = 'ACTIVE', time window, minSeverity, and pagination.
 */
export async function fetchActiveAlerts(
  params: ValidatedAlertQueryParams
): Promise<{ alerts: FormattedAlert[]; total: number }> {
  const { orgId, startTime, endTime, page, limit, allowedSeverities } = params;
  const offset = (page - 1) * limit;

  const queryParams: unknown[] = [orgId, startTime.toISOString(), endTime.toISOString()];
  let paramIndex = queryParams.length + 1;

  let severityClause = '';
  if (allowedSeverities && allowedSeverities.length > 0) {
    const placeholders = allowedSeverities.map(() => `$${paramIndex++}`).join(', ');
    severityClause = `AND severity IN (${placeholders})`;
    queryParams.push(...allowedSeverities);
  }

  // [MISSING PART]: Parameterized SQL query eliminates SQL injection risk
  // [MISSING PART]: Added status = 'ACTIVE' condition
  // [MISSING PART]: Uses COUNT(*) OVER() to obtain total count for pagination metadata in a single query
  const sql = `
    SELECT id, sensor_id, org_id, severity, started_at, last_seen_at, status, COUNT(*) OVER() AS total_count
    FROM sensor_alerts
    WHERE org_id = $1
      AND status = 'ACTIVE'
      AND started_at BETWEEN $2 AND $3
      ${severityClause}
    ORDER BY started_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}
  `;

  queryParams.push(limit, offset);

  const result = await db.query(sql, queryParams);
  const rows: AlertRow[] = result.rows || [];

  const alerts = rows.map((row) => formatAlertRow(row, orgId));

  let total = 0;
  if (rows.length > 0 && rows[0].total_count !== undefined) {
    total = Number(rows[0].total_count);
  } else if (page > 1) {
    // [MISSING PART]: Fallback count query when requested page exceeds total rows
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM sensor_alerts
      WHERE org_id = $1
        AND status = 'ACTIVE'
        AND started_at BETWEEN $2 AND $3
        ${severityClause}
    `;
    const countResult = await db.query(countSql, queryParams.slice(0, queryParams.length - 2));
    total = countResult.rows?.[0]?.count ? Number(countResult.rows[0].count) : 0;
  }

  return { alerts, total };
}

/**
 * Idempotently inserts or updates an alert in sensor_alerts table.
 */
export async function insertOrUpdateSensorAlert(payload: AlertMessagePayload): Promise<void> {
  const normalizedTimestamp = new Date(payload.timestamp).toISOString();

  // [MISSING PART]: Unique constraint idempotency via ON CONFLICT (id) DO UPDATE
  // Prevents duplicate alert insertion on duplicate message delivery
  const insertSql = `
    INSERT INTO sensor_alerts (id, sensor_id, org_id, severity, started_at, last_seen_at, status)
    VALUES ($1, $2, $3, $4, $5, $5, 'ACTIVE')
    ON CONFLICT (id) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      status = 'ACTIVE'
  `;

  await db.query(insertSql, [
    payload.alertId,
    payload.sensorId,
    payload.orgId,
    payload.severity,
    normalizedTimestamp,
  ]);
}

/**
 * [MISSING PART IMPLEMENTED]: Safely handles poison pill messages.
 * Routes to Dead-Letter Queue (DLQ), nacks without requeue, or discards via ack
 * to eliminate poison pills and prevent consumer worker crash loops.
 */
export async function handlePoisonPillMessage(
  msg: QueueMessage,
  reasons: string[]
): Promise<void> {
  if (!msg) return;

  try {
    if (typeof queue.deadLetter === 'function') {
      await queue.deadLetter(msg, reasons.join('; '));
      logStructured('INFO', 'Poison pill message routed to Dead-Letter Queue (DLQ)', {
        messageId: msg.id,
        reasons,
      });
    } else if (typeof queue.nack === 'function') {
      await queue.nack(msg, false); // requeue = false drops message or routes to broker DLQ
      logStructured('INFO', 'Poison pill message rejected without requeue (nack)', {
        messageId: msg.id,
        reasons,
      });
    } else if (typeof queue.ack === 'function') {
      // Discard from queue by acknowledging so worker is not blocked in infinite retry loop
      await queue.ack(msg);
      logStructured('WARN', 'Poison pill message discarded via ack (no DLQ/nack available)', {
        messageId: msg.id,
        reasons,
      });
    }
  } catch (queueError: unknown) {
    logStructured(
      'ERROR',
      'Failed to handle poison pill message on queue',
      { messageId: msg.id, reasons },
      queueError
    );
  }
}

// ============================================================================
// 5. Main Handlers (Clean, Readable Orchestration)
// ============================================================================

/**
 * GET /alerts/active
 * Retrieves active alerts with input validation, auth, active org check, and pagination.
 */
export async function getActiveAlerts(req: AuthenticatedRequest | any, res: any) {
  try {
    // 1. Input Validation
    const validation = validateAlertQueryParams(req.query);
    if (!validation.isValid || !validation.data) {
      return sendStructuredResponse(res, 400, false, null, null, validation.errors);
    }
    const params = validation.data;

    // 2. Authentication & Authorization Check
    const authCheck = validateUserOrgAccess(req.user, params.orgId);
    if (!authCheck.authorized) {
      return sendStructuredResponse(res, authCheck.statusCode || 403, false, null, null, [
        authCheck.error!,
      ]);
    }

    // 3. Organization Active Check
    // [MISSING PART]: Verify organization existence and active status in DB
    const organization = await fetchOrganizationById(params.orgId);
    if (!organization) {
      return sendStructuredResponse(res, 404, false, null, null, ['Organization not found']);
    }
    if (organization.status !== 'ACTIVE') {
      return sendStructuredResponse(res, 403, false, null, null, ['Organization is not active']);
    }

    // 4. Fetch Active Alerts with Pagination & Filtering
    const { alerts, total } = await fetchActiveAlerts(params);

    const totalPages = total === 0 ? 0 : Math.ceil(total / params.limit);
    const pagination: PaginationMeta = {
      page: params.page,
      limit: params.limit,
      total,
      totalPages,
      hasNext: params.page < totalPages,
      hasPrev: params.page > 1,
    };

    // 5. Success Response
    return sendStructuredResponse(res, 200, true, alerts, pagination, []);
  } catch (err: unknown) {
    logStructured('ERROR', 'Error in getActiveAlerts', { error: err });
    const errorMessage = err instanceof Error ? err.message : 'Internal server error';
    return sendStructuredResponse(res, 500, false, null, null, [errorMessage]);
  }
}

/**
 * Queue Consumer: processAlertMessage
 * Processes incoming alert messages idempotently with poison-pill blocking and retry mechanism.
 */
export async function processAlertMessage(
  msg: QueueMessage,
  options: { maxRetries?: number; initialDelayMs?: number } = {}
): Promise<void> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 200;

  // 1. Payload Validation: Malformed JSON or invalid schema blocks job immediately without retry
  const validation = parseAndValidateAlertPayload(msg);
  if (!validation.isValid || !validation.data) {
    logStructured(
      'ERROR',
      'Alert message payload validation failed. Job blocked without retry.',
      {
        messageId: msg?.id,
        rawBody: msg?.body,
        errors: validation.errors,
      }
    );
    // [MISSING PART IMPLEMENTED]: Handle poison pill by routing to DLQ, nacking without requeue, or discarding from queue
    await handlePoisonPillMessage(msg, validation.errors);
    return;
  }

  const payload = validation.data;

  // 2. Retry Loop: Only retries when DB insertion or Queue acknowledgement fails
  let dbInserted = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Step A: Insert into DB first
      if (!dbInserted) {
        logStructured('DEBUG', 'Executing DB insert for alert', {
          alertId: payload.alertId,
          attempt,
        });

        await insertOrUpdateSensorAlert(payload);
        dbInserted = true;

        logStructured('INFO', 'DB insert succeeded for alert', {
          alertId: payload.alertId,
          attempt,
        });
      }

      // Step B: Acknowledge from queue ONLY IF DB insert was successful
      logStructured('DEBUG', 'Acknowledging queue message', {
        alertId: payload.alertId,
        attempt,
      });

      await queue.ack(msg);

      logStructured('INFO', 'Alert message processed and acknowledged successfully', {
        alertId: payload.alertId,
        sensorId: payload.sensorId,
        orgId: payload.orgId,
        attempts: attempt,
      });

      return; // Job successfully completed
    } catch (operationError: unknown) {
      const isLastAttempt = attempt >= maxRetries;
      const failedStage = !dbInserted ? 'DB_INSERT' : 'QUEUE_ACK';

      logStructured(
        'WARN',
        `Alert message processing failed at ${failedStage} (Attempt ${attempt}/${maxRetries})`,
        {
          alertId: payload.alertId,
          attempt,
          maxRetries,
          failedStage,
        },
        operationError
      );

      if (isLastAttempt) {
        logStructured(
          'ERROR',
          `Max retries (${maxRetries}) exhausted for alert processing at ${failedStage}`,
          {
            alertId: payload.alertId,
            attempts: maxRetries,
            failedStage,
          },
          operationError
        );
        throw operationError;
      }

      const backoffDelay = initialDelayMs * Math.pow(2, attempt - 1);
      logStructured('INFO', `Waiting ${backoffDelay}ms before retry...`, {
        alertId: payload.alertId,
        nextAttempt: attempt + 1,
        backoffDelay,
      });
      await sleep(backoffDelay);
    }
  }
}
