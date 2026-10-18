import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { vercelApiProxy } from './vercel-proxy'

export default defineConfig({
  // Vite does not read PORT on its own — it hard-defaults to 5173, so two dev servers
  // (a second dev server, another checkout) collide instead of coexisting. Honouring
  // PORT lets the harness assign a free one; 5173 stays the default when nothing is set.
  //
  // ⚠️  One flow still assumes 5173: lib/handlers/auth-link.js falls back to
  //     'http://localhost:5173/' for a magic link's emailRedirectTo, because that is what
  //     Supabase's redirect allowlist matches. Testing SELF-SERVE signup locally therefore
  //     needs the server on 5173. Instant-access domains (AUTO_ACCESS_DOMAINS) verify a
  //     token hash directly and work on any port.
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) return 'vendor-react';
          if (id.includes('@supabase')) return 'vendor-supabase';
          if (id.includes('lucide-react')) return 'vendor-icons';
          return 'vendor';
        }
      }
    }
  },
  plugins: [
    react(),
    vercelApiProxy(), // Local API Proxy for simulated Serverless
  ],
})
