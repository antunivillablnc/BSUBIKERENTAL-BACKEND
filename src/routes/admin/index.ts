import { Router } from 'express';
import applicationsRouter from './applications';
import bikesRouter from './bikes';
import assignBikeRouter from './assignBike';
import endRentalRouter from './endRental';
import rentalHistoryRouter from './rentalHistory';
import activityLogRouter from './activityLog';
import usersRouter from './users';

const router = Router();

router.use(applicationsRouter);
router.use(bikesRouter);
router.use(assignBikeRouter);
router.use(endRentalRouter);
router.use(rentalHistoryRouter);
router.use(activityLogRouter);
router.use(usersRouter);

export default router;


