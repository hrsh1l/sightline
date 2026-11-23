// PLACEHOLDER (lead scaffold). Vision agent replaces this with the real implementation.
import type { AppConfig } from '../config.js';
import type { DetectorService, Logger } from '../contracts.js';

export function createDetector(_deps: { config: AppConfig; log: Logger }): DetectorService {
  return { enabled: false, model: 'none', detect: () => Promise.resolve(null), health: () => Promise.resolve('disabled') };
}
