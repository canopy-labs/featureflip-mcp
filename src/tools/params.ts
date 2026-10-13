import * as z from 'zod/v4';

// Parameters most tools share, described once. A bare z.string() reaches the agent
// as a name and a type and nothing else, and copies of these had drifted to bare
// in about half the tools (e2e.test.ts now fails on any undescribed parameter).

export const projectParam = z.string().describe('Project key');

export const flagParam = z.string().describe('Flag key or id');

export const environmentParam = z.string().describe('Environment key, e.g. production');

export const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20)'),
  cursor: z.string().optional().describe('next_cursor from a previous response'),
};
