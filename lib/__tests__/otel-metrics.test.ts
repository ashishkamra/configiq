import { beforeEach, describe, expect, it, vi } from 'vitest';

const add = vi.hoisted(() => vi.fn());
const createCounter = vi.hoisted(() => vi.fn(() => ({ add })));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({ createCounter }),
  },
}));

import { recordErrorCode, recordModelRequest } from '../otel-metrics';

describe('OpenTelemetry application metrics', () => {
  beforeEach(() => {
    add.mockClear();
  });

  it('records returned error codes with route and status attributes', () => {
    recordErrorCode('/api/recommend', 'AISIM_TIMEOUT', 504);

    expect(add).toHaveBeenCalledWith(1, {
      'http.route': '/api/recommend',
      'http.response.status_code': 504,
      'error.code': 'AISIM_TIMEOUT',
    });
  });

  it('records recommendation requests by model', () => {
    recordModelRequest('recommend', 'meta-llama/Llama-3.1-8B-Instruct');

    expect(add).toHaveBeenCalledWith(1, {
      'model.name': 'meta-llama/Llama-3.1-8B-Instruct',
    });
  });

  it('uses unknown for missing model names', () => {
    recordModelRequest('predict', '  ');

    expect(add).toHaveBeenCalledWith(1, { 'model.name': 'unknown' });
  });
});
