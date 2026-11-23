import { useSyncExternalStore } from 'react';
import type { AssistantController, AssistantState } from '../contracts.js';

/** Subscribe to the controller's external store. getState() returns a stable reference until it changes. */
export function useAssistantState(controller: AssistantController): AssistantState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
