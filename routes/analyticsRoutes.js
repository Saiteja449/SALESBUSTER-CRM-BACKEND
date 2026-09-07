import express from 'express';
import { logCall, getAnalyticsBySalesperson, getTodayAnalyticsForAll, getAILimits, refreshAILimits } from '../controllers/analyticsController.js';

const router = express.Router();

router.post('/log-call', logCall);
router.get('/today', getTodayAnalyticsForAll);
router.get('/ai-limits', getAILimits);
router.post('/ai-limits/refresh', refreshAILimits);
router.get('/:salesperson', getAnalyticsBySalesperson);

export default router;
