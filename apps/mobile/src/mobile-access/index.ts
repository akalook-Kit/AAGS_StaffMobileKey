import { MOBILE_ACCESS_MODE } from '../config';
import { simulatedMobileAccess } from './simulated';
import { assaAbloyMobileAccess } from './assaabloy';
export type { MobileAccess, DoorAttempt } from './types';
export const mobileAccess = MOBILE_ACCESS_MODE === 'assaabloy' ? assaAbloyMobileAccess : simulatedMobileAccess;
