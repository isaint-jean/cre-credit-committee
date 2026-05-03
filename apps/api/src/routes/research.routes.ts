import { Router, Request, Response } from 'express';
import { searchSponsor, searchMarket, searchNews, searchCrime } from '../services/research.service.js';

export const researchRoutes = Router();

researchRoutes.post('/sponsor', async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query) {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    const result = await searchSponsor(query);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

researchRoutes.post('/market', async (req: Request, res: Response) => {
  try {
    const { address, city } = req.body;
    if (!city) {
      res.status(400).json({ error: 'city is required' });
      return;
    }
    const result = await searchMarket(address || '', city);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

researchRoutes.post('/news', async (req: Request, res: Response) => {
  try {
    const { propertyName, sponsorName } = req.body;
    if (!propertyName && !sponsorName) {
      res.status(400).json({ error: 'propertyName or sponsorName required' });
      return;
    }
    const result = await searchNews(propertyName || '', sponsorName || '');
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

researchRoutes.post('/crime', async (req: Request, res: Response) => {
  try {
    const { address, city } = req.body;
    if (!city) {
      res.status(400).json({ error: 'city is required' });
      return;
    }
    const result = await searchCrime(address || '', city);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
