/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', // static site -> goes inside the Android app (Capacitor)
  images: { unoptimized: true },
  trailingSlash: true,
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
