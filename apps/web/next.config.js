/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@cre/shared', '@cre/contracts'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/api/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
