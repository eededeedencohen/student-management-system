import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import studentRoutes from './routes/studentRoutes.js';
import registrationRoutes from './routes/registrationRoutes.js';
import courseRoutes from './routes/courseRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import expenseRoutes from './routes/expenseRoutes.js';
import cashflowRoutes from './routes/cashflowRoutes.js';
import commissionRoutes from './routes/commissionRoutes.js';
import goalRoutes from './routes/goalRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import exportRoutes from './routes/exportRoutes.js';

import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

// CORS – optionally restrict to CLIENT_ORIGIN(s)
const origins = (process.env.CLIENT_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins, credentials: true } : { origin: true, credentials: true }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

app.get('/api/health', (req, res) =>
  res.json({ success: true, service: 'safra-api', time: new Date().toISOString() })
);

app.use('/api/auth', authRoutes);
app.use('/api/reps', userRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/registrations', registrationRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/cashflow', cashflowRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/export', exportRoutes);

// --- serve the built client (single-server mode) ---------------------------
// The client's production build is copied to server/public. We serve its assets
// statically and fall back to index.html for any non-API route so the SPA's
// client-side router (react-router) handles deep links / refreshes.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../public');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    // let the API 404 handler deal with unknown /api routes and non-GET requests
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(notFound);
app.use(errorHandler);

export default app;
