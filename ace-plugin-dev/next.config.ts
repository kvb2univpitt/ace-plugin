import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // CORS is enabled for development purposes ONLY.
    // The backend calls will be made to the i2b2 PM cell from the plugin.
    return [
      {
        // This applies CORS headers to all routes starting with /api
        source: "/api/i2b2/:path*",
        headers: [
          {
            key: "Access-Control-Allow-Credentials",
            value: "true"
          },
          {
            key: "Access-Control-Allow-Origin",
            value: "*" // Change this to your specific client domain in production
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET,OPTIONS,PATCH,DELETE,POST,PUT"
          },
          {
            key: "Access-Control-Allow-Headers",
            value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization"
          },
        ],
      },
    ];
  },
  output: 'export',
  distDir: 'dist',
  images: {
    unoptimized: true, // required for static exports
  },
  assetPrefix: process.env.NODE_ENV === 'production' ? './' : undefined,
};

export default nextConfig;
