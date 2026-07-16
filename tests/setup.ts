/**
 * Test setup — global fixtures and mocks for Skyloom tests.
 */
import { vi, beforeEach } from 'vitest';
import { MessageBus } from '../src/core/bus';
import { getSecurity, resetSecurity } from '../src/core/security';

// Clear tool state before each test
beforeEach(() => {
  // Runtime-loop tests use synthetic tool names. Make the bypass explicit so
  // production's unknown-tool fail-closed default remains fully testable.
  resetSecurity();
  getSecurity().setMode('bypass');
});
