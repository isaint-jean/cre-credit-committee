/** @type {import('next').NextConfig} */

// The web proxies /api/* to the api service. In dev this is localhost:3001; in prod
// it's the internal Fly api (set API_ORIGIN=http://<api-app>.internal:3001 as a Fly env).
// Kept as a fallback so `npm run dev` / `next start` work unchanged with no env set.
const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3001';

const nextConfig = {
  transpilePackages: ['@cre/shared', '@cre/contracts'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_ORIGIN}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
