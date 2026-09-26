import type { NextConfig } from 'next';

// Where the Next.js server reaches the API. Browsers never use this: they call /api/* on the
// web origin, and the rewrite below (or Nginx / the ALB in deployed environments) forwards it.
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@forge/ui'],
  rewrites() {
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]);
  },
};

export default nextConfig;
