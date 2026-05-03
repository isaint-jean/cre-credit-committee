import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { store } from '../storage/sqlite-store.js';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';

export const authRoutes = Router();

// POST /api/auth/login
authRoutes.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = store.getUserByEmail(email);
  if (!user || !store.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    env.jwtSecret,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// POST /api/auth/register
authRoutes.post('/register', requireAuth, (req: Request, res: Response) => {
  // Only admins can create new users
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can create users' });
  }

  const { email, password, name, role } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }

  const existing = store.getUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  const user = store.createUser({ email, password, name, role });
  res.status(201).json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// GET /api/auth/me
authRoutes.get('/me', requireAuth, (req: Request, res: Response) => {
  const user = store.getUserById(req.user!.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});
