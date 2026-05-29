import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { apiRouter } from './routes/index.js';
import { registerCurrentModelVersion } from './services/consistency-engine.service.js';
import { performDoctrineBootCheck } from './util/doctrine-boot-check.js';
import { performJudgmentEngineBootCheck } from './util/judgment-engine-boot-check.js';
import { performNarrativeEngineBootCheck } from './util/narrative-engine-boot-check.js';

// Boot-time invariants. Throws on weight-sum / rule-coverage / hash drift / penalty-key validity;
// process exits non-zero before the HTTP listener starts.
performDoctrineBootCheck();
performJudgmentEngineBootCheck();
performNarrativeEngineBootCheck();

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    // Allow localhost and ngrok origins
    if (!origin || origin.includes('localhost') || origin.includes('ngrok')) {
      callback(null, true);
    } else {
      callback(null, env.frontendUrl === origin);
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '1gb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api', apiRouter);

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(env.port, () => {
  registerCurrentModelVersion();
  console.log(`CRE Credit Committee API running on port ${env.port}`);
  console.log(`Frontend URL: ${env.frontendUrl}`);
  if (!env.anthropicApiKey) {
    console.warn('WARNING: ANTHROPIC_API_KEY not set. AI analysis will fail.');
  }
  if (!env.braveSearchApiKey) {
    console.warn('WARNING: BRAVE_SEARCH_API_KEY not set. External research disabled.');
  }
});

export default app;
