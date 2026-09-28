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

export function recordErrorCode(route: string, code: string, statusCode: number): void {
  errorResponses.add(1, {
    'http.route': route,
    'http.response.status_code': statusCode,
    'error.code': code,
  });
}

export function recordModelRequest(route: 'recommend' | 'predict', model: unknown): void {
  const modelName = typeof model === 'string' && model.trim() ? model.trim() : 'unknown';
  const counter = route === 'recommend' ? recommendRequests : predictRequests;
  counter.add(1, { 'model.name': modelName });
}
