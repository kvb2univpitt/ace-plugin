import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
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
  // @duckdb/node-bindings ships per-platform .node binaries and dispatches at
  // runtime with platform-specific require() calls. Webpack/Turbopack tries to
  // resolve every branch statically and crashes on the bindings for platforms
  // we don't have installed. Mark the duckdb packages as external so Next
  // leaves them to Node's runtime resolver.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
};

export default nextConfig;
