import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DraftResult, SummaryResponse } from './ai.wire';

/**
 * Contract test. The AI service's own tests write these files from its real responses
 * (apps/ai-service/tests/test_feature_api.py) and fail if they change; this side fails if
 * the API can no longer read them. A change to either side has to update both.
 */
const contract = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../ai-service/tests/contract', `${name}.json`), 'utf8'),
  );

describe('AI service wire contract', () => {
  it('reads a draft result exactly as the AI service writes it', () => {
    const result = DraftResult.parse(contract('draft_result'));
    expect(result.draft.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(result.promptVersion).toBe('issue_draft@1');
    expect(result.usage.costUsd).toMatch(/^\d+\.\d+$/);
  });

  it('reads a summary response exactly as the AI service writes it', () => {
    const response = SummaryResponse.parse(contract('summary_response'));
    expect(response.summary.keyDecisions).toEqual(['Sam Okafor: We decided to store event IDs.']);
    expect(response.omittedComments).toBe(0);
  });
});
