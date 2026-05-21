import { Router } from 'express';
import { analysisRoutes } from './analysis.routes.js';
import { criteriaRoutes } from './criteria.routes.js';
import { researchRoutes } from './research.routes.js';
import { uwIntelligenceRoutes } from './uw-intelligence.routes.js';
import { manifestoRoutes } from './manifesto.routes.js';
import { authRoutes } from './auth.routes.js';
import { renderRoutes } from './render.routes.js';
import { ingestRoutes } from './ingest.routes.js';
import { buildAndIngestRoutes } from './build-and-ingest.routes.js';
import { renderV2Routes } from './render-v2.routes.js';
import { workflowRoutes } from './workflow.routes.js';
import { registryRoutes } from './registry.routes.js';
import { requireAuth } from '../middleware/auth.js';
import { observabilityMiddleware } from '../middleware/observability.middleware.js';

export const apiRouter = Router();

// Observability (post-6.8 telemetry). Pure side-channel; never affects control flow.
// Mounted before all routes so every /api/* request is observed.
apiRouter.use(observabilityMiddleware);

// Auth routes (login is public, register/me require auth)
apiRouter.use('/auth', authRoutes);

// All other routes require authentication
apiRouter.use('/analyses', requireAuth, analysisRoutes);
apiRouter.use('/criteria', requireAuth, criteriaRoutes);
apiRouter.use('/research', requireAuth, researchRoutes);
apiRouter.use('/uw-intelligence', requireAuth, uwIntelligenceRoutes);
apiRouter.use('/manifesto', requireAuth, manifestoRoutes);
apiRouter.use('/underwriting', requireAuth, renderRoutes);

// Graph-backed ingestion (Batch 6.4 — POST /api/ingest)
apiRouter.use('/ingest', requireAuth, ingestRoutes);

// Build-and-ingest (extraction-pipeline Step 5b — POST /api/build-and-ingest).
// Accepts raw multipart uploads, runs buildExtractionResult to compose the
// canonical record, then delegates to ingestExtractionResult. Sibling
// PropertyMetadata is persisted conditionally on best-effort terms.
apiRouter.use('/build-and-ingest', requireAuth, buildAndIngestRoutes);

// Graph-backed render (Batch 6.7 — POST /api/render)
apiRouter.use('/render', requireAuth, renderV2Routes);

// Registry — GET/POST CRUD for LibrarySnapshot, MarketBenchmarks, CreditManifesto.
// Reads gated by requireAuth; writes additionally gated by requirePermission('registry:write')
// inside the router. See routes/registry.routes.ts for the per-record sub-routers.
apiRouter.use('/registry', requireAuth, registryRoutes);

// Phase 4 — committee workflow API (POST /api/committee-actions, GET /api/workflow-state,
// GET /api/committee-timeline, GET /api/audit-replay). Auth + permission enforced
// per-endpoint inside the router.
apiRouter.use(workflowRoutes);
