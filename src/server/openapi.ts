// OpenAPI 3.1 description of the research API, generated from the same Zod
// schemas the server validates with (usable for ChatGPT Actions and other clients).
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { importPayload, runCompleteInput, runCreateInput, runFailInput } from '../shared/research-schema';
import type { AppContext } from './context';

function schema(s: z.ZodTypeAny) {
  return z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
}

export function researchJsonSchemas() {
  return {
    ImportPayload: schema(importPayload),
    RunCreate: schema(runCreateInput),
    RunComplete: schema(runCompleteInput),
    RunFail: schema(runFailInput),
  };
}

export function buildOpenApi(ctx: AppContext, req?: FastifyRequest) {
  const base = ctx.config.publicUrl?.replace(/\/$/, '') ?? (req ? `${req.protocol}://${req.headers.host}` : 'http://localhost:3000');
  const s = researchJsonSchemas();
  const strip = (o: Record<string, unknown>) => {
    const { $schema, ...rest } = o;
    void $schema;
    return rest;
  };
  const ok = { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } };
  const json = (ref: string) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
  const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
  return {
    openapi: '3.1.0',
    info: {
      title: `${ctx.config.appName} research API`,
      version: '1.0.0',
      description:
        'Maintain the event collection: read the watchlist and preferences, import events, artists, festivals and Ibiza residencies, record verification outcomes and report run status. Absent fields keep stored values; null clears them. Personal data is never exposed.',
    },
    servers: [{ url: `${base}/api/research/v1` }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ImportPayload: strip(s.ImportPayload),
        RunCreate: strip(s.RunCreate),
        RunComplete: strip(s.RunComplete),
        RunFail: strip(s.RunFail),
      },
    },
    security: [{ bearer: [] }],
    paths: {
      '/ping': { post: { operationId: 'ping', summary: 'Authenticated connection test (records a completed connection-test run)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { executor: { type: 'string' }, note: { type: 'string' } } } } } }, responses: { 200: ok } } },
      '/context': { get: { operationId: 'getContext', summary: 'Active watchlist, interests, geographic scopes, coverage and research rules — read at the start of every run', responses: { 200: ok } } },
      '/watchlist': { get: { operationId: 'getWatchlist', summary: 'Full watchlist with aliases, identifying links and keys', responses: { 200: ok } } },
      '/taxonomy': { get: { operationId: 'getTaxonomy', summary: 'Valid category and genre slugs', responses: { 200: ok } } },
      '/events': {
        get: {
          operationId: 'listEvents',
          summary: 'List researched events (to find existing ids and source keys)',
          parameters: [
            { name: 'updated_since', in: 'query', schema: { type: 'string' } },
            { name: 'upcoming', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: ok },
        },
      },
      '/events/{id}': { get: { operationId: 'getEvent', summary: 'Full facts for one event', parameters: idParam, responses: { 200: ok } } },
      '/verification-queue': {
        get: {
          operationId: 'getVerificationQueue',
          summary: 'Upcoming listings to recheck, prioritised (booked, soon, sale dates approaching, stale), in batches',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: ok },
        },
      },
      '/runs': { post: { operationId: 'startRun', summary: 'Start a run (status running) when your own scheduler triggers research', requestBody: json('RunCreate'), responses: { 200: ok } } },
      '/runs/claim': { post: { operationId: 'claimRun', summary: 'Claim the oldest queued run (Search now / internal schedule). 204 when none is queued.', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { executor: { type: 'string' }, types: { type: 'array', items: { type: 'string' } } } } } } }, responses: { 200: ok, 204: { description: 'Nothing queued' } } } },
      '/runs/{id}': { get: { operationId: 'getRun', parameters: idParam, summary: 'Run status and recorded errors', responses: { 200: ok } } },
      '/runs/{id}/heartbeat': { post: { operationId: 'heartbeatRun', parameters: idParam, summary: 'Extend the run lease while working', responses: { 200: ok } } },
      '/runs/{id}/complete': { post: { operationId: 'completeRun', parameters: idParam, summary: 'Finish a run with outcome, coverage and summary', requestBody: json('RunComplete'), responses: { 200: ok } } },
      '/runs/{id}/fail': { post: { operationId: 'failRun', parameters: idParam, summary: 'Record a failed run (existing listings are kept)', requestBody: json('RunFail'), responses: { 200: ok } } },
      '/import': {
        post: {
          operationId: 'importData',
          summary: 'Create or update events, artists, festivals, residencies and verification outcomes (idempotent)',
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
          requestBody: json('ImportPayload'),
          responses: { 200: ok, 409: { description: 'Idempotency key reused with a different payload, or run not running' }, 422: { description: 'Validation failed' } },
        },
      },
    },
  };
}
