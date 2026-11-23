// PLACEHOLDER (lead scaffold). Conversation agent replaces this with the real implementation.
import type { ClientSessionFactory } from '../contracts.js';

export const createClientSession: ClientSessionFactory = ({ channel }) => ({
  handleRaw() {
    channel.send({ type: 'error', code: 'internal', message: 'Session handler not implemented yet.', recoverable: false });
  },
  dispose() {},
});
