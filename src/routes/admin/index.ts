import { Router } from 'express';
import applicationsRouter from './applications.js';
import bikesRouter from './bikes.js';
import assignBikeRouter from './assignBike.js';
import endRentalRouter from './endRental.js';
import rentalHistoryRouter from './rentalHistory.js';
import activityLogRouter from './activityLog.js';
import usersRouter from './users.js';

const router = Router();

router.use(applicationsRouter);
router.use(bikesRouter);
router.use(assignBikeRouter);
router.use(endRentalRouter);
router.use(rentalHistoryRouter);
router.use(activityLogRouter);
router.use(usersRouter);

export default router;


