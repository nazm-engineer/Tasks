import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getActiveAlerts, processAlertMessage, QueueMessage } from './index';

describe('Alert Service Unit Tests', () => {
  let mockDb: { query: ReturnType<typeof vi.fn> };
  let mockQueue: {
    ack: ReturnType<typeof vi.fn>;
    nack: ReturnType<typeof vi.fn>;
    deadLetter: ReturnType<typeof vi.fn>;
  };
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const createMockRes = () => {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
    };
    mockQueue = {
      ack: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
      deadLetter: vi.fn().mockResolvedValue(undefined),
    };

    (globalThis as any).db = mockDb;
    (globalThis as any).queue = mockQueue;

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ============================================================================
  // getActiveAlerts (12 Scenarios)
  // ============================================================================
  describe('getActiveAlerts', () => {
    const validReq = () => ({
      user: {
        id: 'user-1',
        orgId: 'org-1',
        isActive: true,
        status: 'ACTIVE',
      },
      query: {
        orgId: 'org-1',
        startTime: '2026-11-20T00:00:00.000Z',
        endTime: '2026-11-25T00:00:00.000Z',
        page: '1',
        limit: '10',
      },
    });

    it('1. should return formatted active alerts with pagination on a successful request', async () => {
      const req = validReq();
      const res = createMockRes();

      const startedAt = new Date('2026-11-24T10:00:00.000Z');
      const lastSeenAt = new Date('2026-11-24T10:05:00.000Z');

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'org-1', status: 'ACTIVE' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'alert-1',
              sensor_id: 'sensor-99',
              org_id: 'org-1',
              severity: 'HIGH',
              started_at: startedAt,
              last_seen_at: lastSeenAt,
              status: 'ACTIVE',
              total_count: '1',
            },
          ],
        });

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 200,
        success: true,
        succcess: true,
        data: [
          {
            id: 'alert-1',
            sensorId: 'sensor-99',
            orgId: 'org-1',
            severity: 'HIGH',
            startedAt: startedAt.toISOString(),
            lastSeenAt: lastSeenAt.toISOString(),
            status: 'ACTIVE',
          },
        ],
        pagination: {
          page: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
        errors: [],
      });
    });

    it('2. should return 401 when user is unauthenticated', async () => {
      const req = { ...validReq(), user: undefined };
      const res = createMockRes();

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 401,
          success: false,
          data: null,
          errors: ['Unauthorized: Missing or invalid authentication credentials'],
        })
      );
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('3. should return 403 when authenticated user is inactive', async () => {
      const req = validReq();
      req.user.isActive = false;
      req.user.status = 'INACTIVE';
      const res = createMockRes();

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 403,
          success: false,
          errors: ['Forbidden: User account is inactive'],
        })
      );
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('4. should return 403 when user does not have access to the requested organization', async () => {
      const req = validReq();
      req.user.orgId = 'org-other';
      const res = createMockRes();

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 403,
          success: false,
          errors: ['Forbidden: User does not have access to the requested organization'],
        })
      );
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('5. should return 403 when the organization is inactive in the database', async () => {
      const req = validReq();
      const res = createMockRes();

      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'org-1', status: 'SUSPENDED' }],
      });

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 403,
          success: false,
          errors: ['Organization is not active'],
        })
      );
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('6. should return 400 when required inputs are missing or invalid', async () => {
      const req = {
        user: { id: 'user-1', orgId: 'org-1', isActive: true },
        query: {
          orgId: '',
          minSeverity: 'EXTREME',
          page: '0',
          limit: '500',
        },
      };
      const res = createMockRes();

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const responseArg = res.json.mock.calls[0][0];
      expect(responseArg.success).toBe(false);
      expect(responseArg.errors.length).toBeGreaterThanOrEqual(4);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('7. should return 400 when time window is invalid (startTime > endTime or malformed dates)', async () => {
      const req = validReq();
      req.query.startTime = '2026-11-26T00:00:00.000Z';
      req.query.endTime = '2026-11-20T00:00:00.000Z';
      const res = createMockRes();

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 400,
          success: false,
          errors: expect.arrayContaining(['startTime cannot be later than endTime']),
        })
      );
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('8. should filter SQL query by status ACTIVE and parameterized time window', async () => {
      const req = validReq();
      const res = createMockRes();

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'org-1', status: 'ACTIVE' }] })
        .mockResolvedValueOnce({ rows: [] });

      await getActiveAlerts(req, res);

      expect(mockDb.query).toHaveBeenCalledTimes(2);
      const [alertSql, alertParams] = mockDb.query.mock.calls[1];
      expect(alertSql).toContain("status = 'ACTIVE'");
      expect(alertSql).toContain('org_id = $1');
      expect(alertSql).toContain('started_at BETWEEN $2 AND $3');
      expect(alertParams).toEqual([
        'org-1',
        '2026-11-20T00:00:00.000Z',
        '2026-11-25T00:00:00.000Z',
        10,
        0,
      ]);
    });

    it('9. should filter alerts by minSeverity threshold (e.g. HIGH includes HIGH and CRITICAL)', async () => {
      const req = validReq();
      (req.query as any).minSeverity = 'HIGH';
      const res = createMockRes();

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'org-1', status: 'ACTIVE' }] })
        .mockResolvedValueOnce({ rows: [] });

      await getActiveAlerts(req, res);

      const [alertSql, alertParams] = mockDb.query.mock.calls[1];
      expect(alertSql).toContain('AND severity IN ($4, $5)');
      expect(alertParams).toEqual([
        'org-1',
        '2026-11-20T00:00:00.000Z',
        '2026-11-25T00:00:00.000Z',
        'HIGH',
        'CRITICAL',
        10,
        0,
      ]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('10. should apply explicit pagination and fall back to default pagination (page=1, limit=20) when omitted', async () => {
      // Case A: Explicit pagination page=2, limit=5
      const reqWithPagination = validReq();
      reqWithPagination.query.page = '2';
      reqWithPagination.query.limit = '5';
      const resA = createMockRes();

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'org-1', status: 'ACTIVE' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'alert-6',
              sensor_id: 's-1',
              org_id: 'org-1',
              severity: 'LOW',
              started_at: '2026-11-21T00:00:00.000Z',
              last_seen_at: '2026-11-21T00:00:00.000Z',
              status: 'ACTIVE',
              total_count: '12',
            },
          ],
        });

      await getActiveAlerts(reqWithPagination, resA);

      const [, paramsA] = mockDb.query.mock.calls[1];
      expect(paramsA.slice(-2)).toEqual([5, 5]); // limit=5, offset=5
      expect(resA.json.mock.calls[0][0].pagination).toEqual({
        page: 2,
        limit: 5,
        total: 12,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      });

      // Case B: Without pagination params
      mockDb.query.mockReset();
      const reqWithoutPagination = validReq();
      delete (reqWithoutPagination.query as any).page;
      delete (reqWithoutPagination.query as any).limit;
      const resB = createMockRes();

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'org-1', status: 'ACTIVE' }] })
        .mockResolvedValueOnce({ rows: [] });

      await getActiveAlerts(reqWithoutPagination, resB);

      const [, paramsB] = mockDb.query.mock.calls[1];
      expect(paramsB.slice(-2)).toEqual([20, 0]); // default limit=20, offset=0
      expect(resB.json.mock.calls[0][0].pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('11. should return 500 structured JSON when database query fails', async () => {
      const req = validReq();
      const res = createMockRes();

      mockDb.query.mockRejectedValueOnce(new Error('Connection timeout'));

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        status: 500,
        success: false,
        succcess: false,
        data: null,
        pagination: null,
        errors: ['Connection timeout'],
      });
    });

    it('12. should catch unexpected non-Error exceptions and log structured error JSON', async () => {
      const req = validReq();
      const res = createMockRes();

      mockDb.query.mockRejectedValueOnce('Unexpected string failure');

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 500,
          success: false,
          errors: ['Internal server error'],
        })
      );
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const loggedPayload = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(loggedPayload.level).toBe('ERROR');
      expect(loggedPayload.message).toBe('Error in getActiveAlerts');
    });

    it('13. should return 404 when the organization is not found in the database', async () => {
      const req = validReq();
      const res = createMockRes();

      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 404,
          success: false,
          errors: ['Organization not found'],
        })
      );
    });

    it('14. should return 400 when time window exceeds 90 days', async () => {
      const req = validReq();
      req.query.startTime = '2026-01-01T00:00:00.000Z';
      req.query.endTime = '2026-06-01T00:00:00.000Z';
      const res = createMockRes();

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 400,
          success: false,
          errors: expect.arrayContaining(['Time window exceeds maximum allowed limit of 90 days']),
        })
      );
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('15. should allow access when orgId is listed in user.orgIds', async () => {
      const req = validReq();
      (req.user as any).orgId = 'primary-org';
      (req.user as any).orgIds = ['primary-org', 'org-1'];
      const res = createMockRes();

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'org-1', status: 'ACTIVE' }] })
        .mockResolvedValueOnce({ rows: [] });

      await getActiveAlerts(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].success).toBe(true);
    });

    it('16. should run fallback count query when page > 1 returns empty rows', async () => {
      const req = validReq();
      req.query.page = '5';
      req.query.limit = '10';
      const res = createMockRes();

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'org-1', status: 'ACTIVE' }] })
        .mockResolvedValueOnce({ rows: [] }) // page 5 has no rows
        .mockResolvedValueOnce({ rows: [{ count: 12 }] }); // fallback COUNT(*) query

      await getActiveAlerts(req, res);

      expect(mockDb.query).toHaveBeenCalledTimes(3);
      expect(mockDb.query.mock.calls[2][0]).toContain('SELECT COUNT(*)::int AS count');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].pagination).toEqual({
        page: 5,
        limit: 10,
        total: 12,
        totalPages: 2,
        hasNext: false,
        hasPrev: true,
      });
    });
  });

  // ============================================================================
  // processAlertMessage (8 Scenarios)
  // ============================================================================
  describe('processAlertMessage', () => {
    const validPayload = {
      alertId: 'alert-100',
      sensorId: 'sensor-1',
      orgId: 'org-1',
      severity: 'CRITICAL',
      timestamp: '2026-11-25T10:00:00.000Z',
    };

    const createValidMsg = (overrides: Partial<QueueMessage> = {}): QueueMessage => ({
      id: 'msg-1',
      body: JSON.stringify(validPayload),
      ...overrides,
    });

    it('13. should block malformed JSON without retrying or calling database', async () => {
      const msg: QueueMessage = {
        id: 'msg-bad-json',
        body: '{ invalid-json: ',
      };

      await processAlertMessage(msg, { maxRetries: 3, initialDelayMs: 1 });

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockQueue.deadLetter).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('14. should successfully insert alert into DB and acknowledge queue message', async () => {
      const msg = createValidMsg();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await processAlertMessage(msg, { maxRetries: 3, initialDelayMs: 1 });

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sensor_alerts'),
        [
          validPayload.alertId,
          validPayload.sensorId,
          validPayload.orgId,
          validPayload.severity,
          validPayload.timestamp,
        ]
      );
      expect(mockQueue.ack).toHaveBeenCalledTimes(1);
      expect(mockQueue.ack).toHaveBeenCalledWith(msg);
    });

    it('15. should block invalid payload schema without retrying', async () => {
      const msg: QueueMessage = {
        id: 'msg-bad-schema',
        body: JSON.stringify({
          alertId: '',
          sensorId: 'sensor-1',
          orgId: 'org-1',
          severity: 'UNKNOWN_LEVEL',
          timestamp: 'not-a-date',
        }),
      };

      await processAlertMessage(msg, { maxRetries: 3, initialDelayMs: 1 });

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockQueue.deadLetter).toHaveBeenCalledTimes(1);
      expect(mockQueue.ack).not.toHaveBeenCalled();
    });

    it('16. should insert into DB before acknowledging queue message and never ack if DB fails', async () => {
      const callOrder: string[] = [];
      mockDb.query.mockImplementation(async () => {
        callOrder.push('db.query');
        return { rows: [], rowCount: 1 };
      });
      mockQueue.ack.mockImplementation(async () => {
        callOrder.push('queue.ack');
      });

      await processAlertMessage(createValidMsg(), { maxRetries: 1, initialDelayMs: 1 });
      expect(callOrder).toEqual(['db.query', 'queue.ack']);

      // Verify ack is never called when DB insert fails
      mockDb.query.mockRejectedValue(new Error('DB write failure'));
      mockQueue.ack.mockClear();

      await expect(
        processAlertMessage(createValidMsg(), { maxRetries: 2, initialDelayMs: 1 })
      ).rejects.toThrow('DB write failure');
      expect(mockQueue.ack).not.toHaveBeenCalled();
    });

    it('17. should handle duplicate message delivery idempotently using ON CONFLICT unique constraint', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 });
      const msg = createValidMsg();

      await processAlertMessage(msg, { maxRetries: 3, initialDelayMs: 1 });
      await processAlertMessage(msg, { maxRetries: 3, initialDelayMs: 1 });

      expect(mockDb.query).toHaveBeenCalledTimes(2);
      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
      expect(mockQueue.ack).toHaveBeenCalledTimes(2);
    });

    it('18. should retry on transient database failure and succeed when DB recovers', async () => {
      mockDb.query
        .mockRejectedValueOnce(new Error('Transient DB error 1'))
        .mockRejectedValueOnce(new Error('Transient DB error 2'))
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await processAlertMessage(createValidMsg(), { maxRetries: 3, initialDelayMs: 1 });

      expect(mockDb.query).toHaveBeenCalledTimes(3);
      expect(mockQueue.ack).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
    });

    it('19. should throw error and stop retrying when retry limit is exceeded', async () => {
      mockDb.query.mockRejectedValue(new Error('Persistent DB outage'));

      await expect(
        processAlertMessage(createValidMsg(), { maxRetries: 3, initialDelayMs: 1 })
      ).rejects.toThrow('Persistent DB outage');

      expect(mockDb.query).toHaveBeenCalledTimes(3);
      expect(mockQueue.ack).not.toHaveBeenCalled();
    });

    it('20. should emit structured JSON error logs on validation and processing failures', async () => {
      // Validation failure log
      await processAlertMessage({ id: 'msg-err', body: '{bad' }, { maxRetries: 1, initialDelayMs: 1 });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const validationLog = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(validationLog).toMatchObject({
        level: 'ERROR',
        message: 'Alert message payload validation failed. Job blocked without retry.',
        context: {
          messageId: 'msg-err',
        },
      });
      expect(validationLog.timestamp).toBeDefined();

      // Retry exhaustion error log
      consoleErrorSpy.mockClear();
      mockDb.query.mockRejectedValue(new Error('Disk full'));
      await expect(
        processAlertMessage(createValidMsg(), { maxRetries: 2, initialDelayMs: 1 })
      ).rejects.toThrow('Disk full');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const exhaustLog = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(exhaustLog).toMatchObject({
        level: 'ERROR',
        context: {
          alertId: validPayload.alertId,
          attempts: 2,
          failedStage: 'DB_INSERT',
        },
        error: {
          message: 'Disk full',
        },
      });
    });

    it('25. should only retry queue.ack without re-inserting into DB when queue.ack fails transiently', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockQueue.ack
        .mockRejectedValueOnce(new Error('Queue network blip'))
        .mockResolvedValueOnce(undefined);

      await processAlertMessage(createValidMsg(), { maxRetries: 3, initialDelayMs: 1 });

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockQueue.ack).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const warnLog = JSON.parse(consoleWarnSpy.mock.calls[0][0]);
      expect(warnLog.context.failedStage).toBe('QUEUE_ACK');
    });

    it('26. should fall back to queue.nack or queue.ack for poison pill when queue.deadLetter is unavailable', async () => {
      // Fallback to nack(msg, false)
      (globalThis as any).queue = {
        ack: vi.fn().mockResolvedValue(undefined),
        nack: vi.fn().mockResolvedValue(undefined),
      };
      await processAlertMessage({ id: 'msg-nack', body: '{bad' }, { maxRetries: 1, initialDelayMs: 1 });
      expect((globalThis as any).queue.nack).toHaveBeenCalledWith(
        { id: 'msg-nack', body: '{bad' },
        false
      );
      expect((globalThis as any).queue.ack).not.toHaveBeenCalled();

      // Fallback to ack(msg) when neither deadLetter nor nack exists
      (globalThis as any).queue = {
        ack: vi.fn().mockResolvedValue(undefined),
      };
      await processAlertMessage({ id: 'msg-ack', body: '{bad' }, { maxRetries: 1, initialDelayMs: 1 });
      expect((globalThis as any).queue.ack).toHaveBeenCalledWith({ id: 'msg-ack', body: '{bad' });
    });
  });
});
