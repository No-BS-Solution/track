import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { cpSync, mkdirSync } from 'node:fs'

// Fail fast if the Supabase config is missing or is a key that must never ship in a public bundle.
function checkSupabaseEnv(url: string | undefined, key: string | undefined): void {
  const fail = (why: string): never => {
    throw new Error(`\n\n[track] ${why}\nSee README "Configuration".\n`)
  }
  if (!url) fail('VITE_SUPABASE_URL is missing. Set it in .env.local or as a GitHub repository secret.')
  if (!key) fail('VITE_SUPABASE_ANON_KEY is missing. Set it in .env.local or as a GitHub repository secret.')
  const secret = 'VITE_SUPABASE_ANON_KEY is a secret/service role key. It would be published in the JS bundle and bypass all Row Level Security. Use the anon (publishable) key instead, and rotate the leaked key if it was ever committed or deployed.'
  if (key!.startsWith('sb_secret_')) fail(secret)
  const parts = key!.split('.')
  if (parts.length === 3) {
    let role: unknown
    try {
      role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role
    } catch {
      fail('VITE_SUPABASE_ANON_KEY looks like a JWT but its payload could not be decoded.')
    }
    if (role === 'service_role') fail(secret)
  }
}

// MediaPipe's WebAssembly runtime (camera background blur) is served from our own origin, since the CSP
// allows no CDNs. Copied into public/ (gitignored) so dev and build both serve it.
function copyMediaPipe(): void {
  mkdirSync('public/mediapipe', { recursive: true })
  for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'])
    cpSync(`node_modules/@mediapipe/tasks-vision/wasm/${f}`, `public/mediapipe/${f}`)
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  checkSupabaseEnv(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  copyMediaPipe()
  return {
    // Forks deploy under their own repo name: https://<user>.github.io/<repo>/
    base: env.BASE_PATH || '/track/',
    server: { host: '127.0.0.1', port: 5501, strictPort: true },
    plugins: [
      react(),
      {
        // The CSP blocks the inline React Refresh preamble the dev server injects, so it only applies to builds.
        name: 'strip-csp-in-dev',
        apply: 'serve',
        transformIndexHtml: (html: string) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
      },
      VitePWA({
        registerType: 'autoUpdate',
        // Custom worker (src/sw.ts) so it can show push notifications and open the app when one is tapped.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'Track',
          short_name: 'Track',
          description: 'Simple team chat and board',
          theme_color: '#2f6fed',
          background_color: '#ffffff',
          display: 'standalone',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
          // The blur runtime is large and optional; fetch it on demand instead of precaching it for everyone.
          globIgnores: ['mediapipe/**', 'models/**', '**/vision_bundle*.js'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
      }),
    ],
  }
})
