import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const serviceName = process.env.OTEL_SERVICE_NAME || 'configiq-webapp';

export function getOtlpEndpoint(
  signalVariable: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' | 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  signalPath: 'v1/traces' | 'v1/metrics',
): string | undefined {
  const signalEndpoint = process.env[signalVariable];
  if (signalEndpoint) {
    try {
      const parsed = new URL(signalEndpoint);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`);
      }
      return parsed.toString();
    } catch (error) {
      console.warn(`OpenTelemetry ${signalVariable} is invalid; export disabled.`, error);
      return undefined;
    }
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return undefined;
  }

  try {
    const baseUrl = new URL(endpoint);
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error(`Unsupported protocol: ${baseUrl.protocol}`);
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
    return new URL(signalPath, baseUrl).toString();
  } catch (error) {
    console.warn('OpenTelemetry OTLP endpoint is invalid; export disabled.', error);
    return undefined;
  }
}

export function getTraceEndpoint(): string | undefined {
  return getOtlpEndpoint('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'v1/traces');
}

export function initOtel(): NodeSDK {
  const traceEndpoint = getTraceEndpoint();
  const metricsEndpoint = getOtlpEndpoint('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'v1/metrics');
  const sdk = new NodeSDK({
    ...(traceEndpoint
      ? { traceExporter: new OTLPTraceExporter({ url: traceEndpoint }) }
      : {}),
    ...(metricsEndpoint
      ? {
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
          }),
        }
      : {}),
    instrumentations: [getNodeAutoInstrumentations()],
    serviceName,
  });

  sdk.start();

  const shutdown = async (signal: NodeJS.Signals) => {
    try {
      await sdk.shutdown();
    } catch (error) {
      console.error('OpenTelemetry shutdown failed.', error);
    } finally {
      // Re-send the signal so Node retains its normal termination behavior.
      process.kill(process.pid, signal);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  console.info(
    traceEndpoint
      ? `OpenTelemetry initialized with OTLP endpoint: ${traceEndpoint}`
      : 'OpenTelemetry initialized without an OTLP exporter'
  );

  return sdk;
}
