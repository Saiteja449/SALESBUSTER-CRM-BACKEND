import express from 'express';
import { login, guestRegister } from '../controllers/authController.js';

const router = express.Router();

router.post('/login', login);
router.post('/guest-register', guestRegister);

export default router;
