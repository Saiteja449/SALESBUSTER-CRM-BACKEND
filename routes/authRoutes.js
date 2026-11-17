import express from 'express';
import { login, guestRegister } from '../controllers/authController.js';
import {
  sendOtp,
  verifyOtp,
  completeProfile,
} from '../controllers/otpAuthController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Existing Auth routes (Preserved strictly for Website and other apps)
router.post('/login', login);
router.post('/guest-register', guestRegister);

// Phone Number & Fast2SMS 4-Digit OTP routes
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/complete-profile', protect, completeProfile);

export default router;
