import { Router } from 'express';
import { analysisRoutes } from './analysis.routes.js';
import { criteriaRoutes } from './criteria.routes.js';
import { researchRoutes } from './research.routes.js';
import { uwIntelligenceRoutes } from './uw-intelligence.routes.js';
import { manifestoRoutes } from './manifesto.routes.js';
import { authRoutes } from './auth.routes.js';
import { requireAuth } from '../middleware/auth.js';

export const apiRouter = Router();

// Auth routes (login is public, register/me require auth)
apiRouter.use('/auth', authRoutes);

// All other routes require authentication
apiRouter.use('/analyses', requireAuth, analysisRoutes);
apiRouter.use('/criteria', requireAuth, criteriaRoutes);
apiRouter.use('/research', requireAuth, researchRoutes);
apiRouter.use('/uw-intelligence', requireAuth, uwIntelligenceRoutes);
apiRouter.use('/manifesto', requireAuth, manifestoRoutes);
