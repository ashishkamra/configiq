import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('configiq-webapp');

const errorResponses = meter.createCounter('configiq.errors', {
  description: 'Structured error responses returned by ConfigIQ',
  unit: '1',
});

const recommendRequests = meter.createCounter('configiq.recommend.requests', {
  description: 'Recommendation requests received by ConfigIQ',
  unit: '1',
});

const predictRequests = meter.createCounter('configiq.predict.requests', {
  description: 'Prediction requests received by ConfigIQ',
  unit: '1',
});

const ERROR_CATEGORIES = new Set([
  'AISIM_ERROR',
  'AISIM_INVALID_RESPONSE',
  'AISIM_NO_CONFIGURATION',
  'AISIM_NOT_CONFIGURED',
  'AISIM_TIMEOUT',
  'AISIM_UNAVAILABLE',
  'AUTH_REQUIRED',
  'COSTINGS_ERROR',
  'COSTINGS_TIMEOUT',
  'COSTINGS_UNAVAILABLE',
  'gated',
  'INTERNAL_ERROR',
  'internal_error',
  'INVALID_REQUEST',
  'invalid_model_id',
  'MODEL_NOT_FOUND',
  'MOE_PARAMS_REQUIRED',
  'network_error',
  'not_found',
  'OOM',
  'UNHANDLED_ERROR',
  'validation_error',
]);

const MODEL_CATEGORIES = [
  ['gemma', /gemma/i],
  ['nemotron', /nemotron/i],
  ['deepseek', /deepseek/i],
  ['qwen', /qwen/i],
  ['gpt-oss', /gpt[-_ ]?oss/i],
  ['glm', /(?:^|[^a-z])glm(?:[^a-z]|$)/i],
  ['kimi', /kimi/i],
] as const;

function boundedErrorCode(code: string): string {
  return ERROR_CATEGORIES.has(code) ? code : 'unknown';
}

function boundedModelCategory(model: unknown): string {
  if (typeof model !== 'string') return 'other';
  const category = MODEL_CATEGORIES.find(([, pattern]) => pattern.test(model));
  return category?.[0] ?? 'other';
}

export function recordErrorCode(route: string, code: string, statusCode: number): void {
  errorResponses.add(1, {
    'http.route': route,
    'http.response.status_code': statusCode,
    'error.code': boundedErrorCode(code),
  });
}

export function recordModelRequest(route: 'recommend' | 'predict', model: unknown): void {
  const counter = route === 'recommend' ? recommendRequests : predictRequests;
  counter.add(1, { 'model.category': boundedModelCategory(model) });
}
