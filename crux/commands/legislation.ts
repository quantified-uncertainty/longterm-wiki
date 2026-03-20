/**
 * Legislation Command Domain
 *
 * Commands for managing and verifying policy/legislation data.
 *
 * Usage:
 *   crux tb legislation verify-stakeholders     Verify stakeholder position evidence
 *   crux tb legislation verify-stakeholders --policy=california-sb1047 --verbose
 */

// Re-export from the implementation module
export { commands, getHelp } from './legislation/verify-stakeholders.ts';
