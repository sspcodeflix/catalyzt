import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { createApi } from './server/api';
import { openDb, type HorizonDb } from './server/db';
import { configFromEnv } from './server/deepseek';

/**
 * Serves /api from the Vite dev and preview servers. Env vars without the VITE_ prefix (like
 * DEEPSEEK_API_KEY) are never exposed to the browser bundle.
 */
function horizonApi(env: Record<string, string>): Plugin {
  const cfg = configFromEnv(env);
  // Opened lazily, so `vite build` never touches the database.
  let db: HorizonDb | null = null;
  const getDb = () => {
    if (!db) {
      db = openDb(env.HORIZON_DB_PATH || 'data/horizon.db');
      // Anything still marked running belongs to a server that stopped; close it.
      db.stopOrphans();
    }
    return db;
  };
  const api = createApi(() => cfg, getDb, { githubToken: env.GITHUB_TOKEN?.trim() || undefined, ingestToken: env.HEXA_INGEST_TOKEN?.trim() || undefined });
  return {
    name: 'horizon-api',
    configureServer(server) {
      server.middlewares.use(api);
      server.config.logger.info(cfg ? `  Horizon API: DeepSeek at ${new URL(cfg.baseUrl).host} (${cfg.chatModel})` : '  Horizon API: DeepSeek not configured, using rules only');
    },
    configurePreviewServer(server) {
      server.middlewares.use(api);
    },
  };
}

export default defineConfig(({ mode }) => {
  // '' loads every variable from .env files and the process environment, not just VITE_*.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), horizonApi(env)],
    // The design tokens live in ../design/tokens.css and are imported directly, so the app
    // and the mock-ups always share one source of truth.
    server: { fs: { allow: ['..'] } },
  };
});
