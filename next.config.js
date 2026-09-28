/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async redirects() {
    return [
      {
        source: '/performance',
        destination: '/predict',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/widgets/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
          { key: 'Cache-Control', value: 'public, max-age=0, s-maxage=300, must-revalidate' },
        ],
      },
    ];
  },
  transpilePackages: [
    "@patternfly/react-core",
    "@patternfly/react-charts",
    "@patternfly/react-icons",
    "@patternfly/react-table",
  ],
  serverExternalPackages: [
    '@opentelemetry/api',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/sdk-node',
  ],
  webpack(config, { dev, isServer }) {
    if (dev) {
      config.cache = { type: 'memory' };
    }
    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        /^@opentelemetry\//,
        '@grpc/grpc-js',
      ];
    }
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /@patternfly[\\/]react-styles[\\/]css[\\/]components[\\/](ActionList|OverflowMenu)/,
        message: /autoprefixer: start value has mixed support/,
      },
    ];
    return config;
  },
};

module.exports = nextConfig;
