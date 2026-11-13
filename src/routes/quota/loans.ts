import { FastifyPluginAsync } from 'fastify';
import { db } from '../../db';
import { loans } from '../../db/schema';
import { eq, or, and, desc, sql } from 'drizzle-orm';
import { LoanService, NotFoundError, ConflictError } from '../../services/loan.service';

const loanSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    lender_org_id: { type: 'string', format: 'uuid' },
    borrower_org_id: { type: 'string', format: 'uuid' },
    amount: { type: 'integer', example: 2000 },
    status: { type: 'string', enum: ['active', 'repaid', 'expired', 'cancelled'], example: 'active' },
    note: { type: ['string', 'null'], nullable: true, example: 'Cross-cluster assistance' },
    created_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    settled_at: { type: ['string', 'null'], format: 'date-time', nullable: true },
  },
  required: ['id', 'lender_org_id', 'borrower_org_id', 'amount', 'status', 'created_at', 'expires_at'],
  additionalProperties: true,
};

const settledLoanSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['repaid', 'cancelled'], example: 'repaid' },
    settled_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'status', 'settled_at'],
  additionalProperties: true,
};

const loansRoutes: FastifyPluginAsync = async (fastify) => {
  const loanService = new LoanService(fastify);

  fastify.post<{
    Body: { borrower_org_id: string; amount: number; ttl_seconds?: number; note?: string };
    Headers: { 'x-idempotency-key': string };
  }>('/', {
    schema: {
      tags: ['Loans'],
      summary: 'Create peer-to-peer quota loan',
      description: 'Admin-only endpoint. Creates an atomic quota loan from caller organization to borrower organization with a specified TTL.',
      security: [{ ApiKeyAuth: [] }],
      headers: {
        type: 'object',
        properties: {
          'x-idempotency-key': { type: 'string', description: 'Unique idempotency key' },
        },
        required: ['x-idempotency-key'],
      },
      body: {
        type: 'object',
        required: ['borrower_org_id', 'amount'],
        properties: {
          borrower_org_id: { type: 'string', format: 'uuid', description: 'Target borrower organization UUID' },
          amount: { type: 'integer', minimum: 1, description: 'Loan quota amount' },
          ttl_seconds: { type: 'integer', minimum: 1, maximum: 2592000, description: 'Loan duration in seconds (default 3600, max 30 days)' },
          note: { type: 'string', description: 'Optional context note' },
        },
      },
      response: {
        201: {
          description: 'Loan created successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: loanSchema,
          },
          required: ['success', 'data'],
        },
        400: {
          description: 'Validation error or self-loan prohibited',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        403: {
          description: 'Forbidden - admin access required',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Admin access required' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        409: {
          description: 'Idempotency collision conflict',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'IDEMPOTENCY_STATE_ERROR' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        422: {
          description: 'Insufficient quota available to create loan',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'INSUFFICIENT_QUOTA' },
                message: { type: 'string', example: 'Not enough quota available' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    // Admin only guard
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const lenderOrgId = request.auth.orgId;
    const { borrower_org_id, amount, ttl_seconds, note } = request.body;
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Missing X-Idempotency-Key header' } });
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'amount must be a positive integer' } });
    }

    const ttlSeconds = typeof ttl_seconds === 'number' ? ttl_seconds : 3600;

    if (ttlSeconds <= 0 || ttlSeconds > 30 * 24 * 60 * 60) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_EXPIRY', message: 'ttl_seconds must be > 0 and <= 30 days' }
      });
    }

    try {
      const loan = await loanService.createLoan({
        lenderOrgId,
        borrowerOrgId: borrower_org_id,
        amount,
        ttlSeconds,
        note,
        idempotencyKey,
      });

      // API contract format
      const formattedLoan = {
        id: loan.id,
        lender_org_id: loan.lenderOrgId,
        borrower_org_id: loan.borrowerOrgId,
        amount: loan.amount,
        status: loan.status,
        note: loan.note,
        created_at: loan.createdAt,
        expires_at: loan.expiresAt,
        settled_at: loan.settledAt,
      };

      return reply.status(201).send({ success: true, data: formattedLoan });
    } catch (err: any) {
      if (err.message === 'SELF_LOAN') {
        return reply.status(400).send({ success: false, error: { code: 'SELF_LOAN', message: 'Cannot loan quota to your own organization' }});
      }
      if (err.message === 'INSUFFICIENT_QUOTA') {
        return reply.status(422).send({ success: false, error: { code: 'INSUFFICIENT_QUOTA', message: 'Not enough quota available' }});
      }
      if (err.message === 'Idempotency collision but loan not found') {
        return reply.status(409).send({ success: false, error: { code: 'IDEMPOTENCY_STATE_ERROR', message: err.message }});
      }
      throw err;
    }
  });

  fastify.post<{
    Params: { id: string };
    Headers: { 'x-idempotency-key'?: string };
  }>('/:id/repay', {
    schema: {
      tags: ['Loans'],
      summary: 'Repay an active quota loan',
      description: 'Admin-only endpoint. Borrower repays the active loan back to lender org.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Loan UUID' },
        },
      },
      headers: {
        type: 'object',
        properties: {
          'x-idempotency-key': { type: 'string', description: 'Optional idempotency key' },
        },
      },
      response: {
        200: {
          description: 'Loan repaid successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: settledLoanSchema,
          },
          required: ['success', 'data'],
        },
        403: {
          description: 'Forbidden - only borrower can repay loan',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Only the borrower can repay the loan' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Loan not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Loan not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        409: {
          description: 'Loan already settled or cancelled',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'LOAN_ALREADY_SETTLED' },
                message: { type: 'string', example: 'This loan has already been settled or cancelled' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { id } = request.params;
    const idempotencyKey = request.headers['x-idempotency-key'];

    try {
      const loan = await loanService.settleLoan({
        loanId: id,
        actorOrgId: request.auth.orgId,
        settleType: 'repay',
        idempotencyKey,
      });

      const formattedLoan = {
        id: loan.id,
        status: loan.status,
        settled_at: loan.settledAt,
      };

      return reply.send({ success: true, data: formattedLoan });
    } catch (err: any) {
      if (err instanceof ConflictError || err.message === 'RACE_CONDITION_LOAN_ALREADY_SETTLED') {
        return reply.status(409).send({ success: false, error: { code: 'LOAN_ALREADY_SETTLED', message: 'This loan has already been settled or cancelled' }});
      }
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Loan not found' }});
      }
      if (err.message === 'UNAUTHORIZED_ACTOR') {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Only the borrower can repay the loan' }});
      }
      throw err;
    }
  });

  fastify.post<{
    Params: { id: string };
    Headers: { 'x-idempotency-key'?: string };
  }>('/:id/cancel', {
    schema: {
      tags: ['Loans'],
      summary: 'Cancel an active quota loan',
      description: 'Admin-only endpoint. Lender cancels an active loan and reclaims quota.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Loan UUID' },
        },
      },
      headers: {
        type: 'object',
        properties: {
          'x-idempotency-key': { type: 'string', description: 'Optional idempotency key' },
        },
      },
      response: {
        200: {
          description: 'Loan cancelled successfully',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: settledLoanSchema,
          },
          required: ['success', 'data'],
        },
        403: {
          description: 'Forbidden - only lender can cancel loan',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Only the lender can cancel the loan' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Loan not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Loan not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        409: {
          description: 'Loan already settled or cancelled',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'LOAN_ALREADY_SETTLED' },
                message: { type: 'string', example: 'This loan has already been settled or cancelled' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { id } = request.params;
    const idempotencyKey = request.headers['x-idempotency-key'];

    try {
      const loan = await loanService.settleLoan({
        loanId: id,
        actorOrgId: request.auth.orgId,
        settleType: 'cancel',
        idempotencyKey,
      });

      const formattedLoan = {
        id: loan.id,
        status: loan.status,
        settled_at: loan.settledAt,
      };

      return reply.send({ success: true, data: formattedLoan });
    } catch (err: any) {
      if (err instanceof ConflictError || err.message === 'RACE_CONDITION_LOAN_ALREADY_SETTLED') {
        return reply.status(409).send({ success: false, error: { code: 'LOAN_ALREADY_SETTLED', message: 'This loan has already been settled or cancelled' }});
      }
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Loan not found' }});
      }
      if (err.message === 'UNAUTHORIZED_ACTOR') {
        return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Only the lender can cancel the loan' }});
      }
      throw err;
    }
  });

  fastify.get<{
    Querystring: { role?: 'lender' | 'borrower'; status?: 'active' | 'settled'; limit?: string; cursor?: string };
  }>('/', {
    schema: {
      tags: ['Loans'],
      summary: 'List organization quota loans',
      description: 'Admin-only endpoint. Lists quota loans for caller organization with optional role and status filters, and cursor-based pagination.',
      security: [{ ApiKeyAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['lender', 'borrower'], description: 'Filter loans by role' },
          status: { type: 'string', enum: ['active', 'settled'], description: 'Filter loans by status' },
          limit: { type: 'string', description: 'Page limit (1-100, default 50)' },
          cursor: { type: 'string', description: 'Base64 cursor for next page' },
        },
      },
      response: {
        200: {
          description: 'Paginated list of loans',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'array',
              items: loanSchema,
            },
            meta: {
              type: 'object',
              properties: {
                next_cursor: { type: ['string', 'null'], nullable: true },
              },
              required: ['next_cursor'],
            },
          },
          required: ['success', 'data', 'meta'],
        },
        403: {
          description: 'Forbidden - admin access required',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Admin access required' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { orgId } = request.auth;
    const { role, status, cursor } = request.query;
    const queryLimit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    
    const filters = [];
    
    if (role === 'lender') {
      filters.push(eq(loans.lenderOrgId, orgId));
    } else if (role === 'borrower') {
      filters.push(eq(loans.borrowerOrgId, orgId));
    } else {
      filters.push(
        or(eq(loans.lenderOrgId, orgId), eq(loans.borrowerOrgId, orgId))
      );
    }

    if (status === 'active') {
      filters.push(eq(loans.status, 'active'));
    } else if (status === 'settled') {
      filters.push(sql`${loans.status} != 'active'`);
    }

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
        const [cursorTime, cursorId] = decoded.split('_');
        if (cursorTime && cursorId) {
          filters.push(sql`(${loans.createdAt} < ${cursorTime}::timestamptz OR (${loans.createdAt} = ${cursorTime}::timestamptz AND ${loans.id} < ${cursorId}))`);
        }
      } catch (e) {
        // ignore invalid cursor
      }
    }

    const results = await db
      .select()
      .from(loans)
      .where(and(...filters))
      .orderBy(desc(loans.createdAt), desc(loans.id))
      .limit(queryLimit + 1);

    const hasMore = results.length > queryLimit;
    const items = hasMore ? results.slice(0, queryLimit) : results;

    let next_cursor = null;
    if (hasMore) {
      const lastItem = items[items.length - 1];
      next_cursor = Buffer.from(`${new Date(lastItem.createdAt).toISOString()}_${lastItem.id}`).toString('base64');
    }

    const formatted = items.map(l => ({
      id: l.id,
      lender_org_id: l.lenderOrgId,
      borrower_org_id: l.borrowerOrgId,
      amount: l.amount,
      status: l.status,
      note: l.note,
      created_at: l.createdAt,
      expires_at: l.expiresAt,
      settled_at: l.settledAt,
    }));

    return reply.send({ success: true, data: formatted, meta: { next_cursor } });
  });

  fastify.get<{
    Params: { id: string };
  }>('/:id', {
    schema: {
      tags: ['Loans'],
      summary: 'Get quota loan by ID',
      description: 'Admin-only endpoint. Retrieves details for a specific quota loan.',
      security: [{ ApiKeyAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Loan UUID' },
        },
      },
      response: {
        200: {
          description: 'Loan details',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: loanSchema,
          },
          required: ['success', 'data'],
        },
        403: {
          description: 'Forbidden - admin access required',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'FORBIDDEN' },
                message: { type: 'string', example: 'Admin access required' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
        404: {
          description: 'Loan not found',
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'NOT_FOUND' },
                message: { type: 'string', example: 'Loan not found' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth.isAdmin) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { orgId } = request.auth;
    const { id } = request.params;

    const [loan] = await db
      .select()
      .from(loans)
      .where(
        and(
          eq(loans.id, id),
          or(eq(loans.lenderOrgId, orgId), eq(loans.borrowerOrgId, orgId))
        )
      )
      .limit(1);

    if (!loan) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Loan not found' }});
    }

    const formattedLoan = {
      id: loan.id,
      lender_org_id: loan.lenderOrgId,
      borrower_org_id: loan.borrowerOrgId,
      amount: loan.amount,
      status: loan.status,
      note: loan.note,
      created_at: loan.createdAt,
      expires_at: loan.expiresAt,
      settled_at: loan.settledAt,
    };

    return reply.send({ success: true, data: formattedLoan });
  });
};

export default loansRoutes;
