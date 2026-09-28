import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTraceEndpoint } from '../otel';

describe('getTraceEndpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns no endpoint when export is not configured', () => {
    expect(getTraceEndpoint()).toBeUndefined();
  });

  it('appends the trace path without duplicating a trailing slash', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://collector.example/');

    expect(getTraceEndpoint()).toBe('https://collector.example/v1/traces');
  });

  it('preserves an OTLP endpoint path prefix', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://collector.example/otel/');

    expect(getTraceEndpoint()).toBe('https://collector.example/otel/v1/traces');
  });

  it('prefers the explicit trace endpoint', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://collector.example/base');
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'https://collector.example/custom-traces');

    expect(getTraceEndpoint()).toBe('https://collector.example/custom-traces');
  });

  it('disables export for an invalid endpoint', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'not-a-url');

    expect(getTraceEndpoint()).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});
