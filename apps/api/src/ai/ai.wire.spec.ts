import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ChatResultEvent,
  ChatToolCallEvent,
  DraftResult,
  IndexResponse,
  QueryIssuesArgs,
  RelatedResponse,
  ReviewResponse,
  SearchResponse,
  SummaryResponse,
} from './ai.wire';

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

  it('reads retrieval responses exactly as the AI service writes them', () => {
    expect(IndexResponse.parse(contract('index_response')).status).toBe('indexed');
    const search = SearchResponse.parse(contract('search_response'));
    expect(search.results[0]?.keywordRank).not.toBeUndefined();
    const related = RelatedResponse.parse(contract('related_response'));
    expect(related.results[0]?.score).toBeGreaterThanOrEqual(related.threshold);
  });

  it('reads chat events exactly as the AI service writes them', () => {
    const result = ChatResultEvent.parse(contract('chat_result_event'));
    expect(result.citations[0]?.n).toBe(1);
    expect(result.promptVersion).toBe('chat_answer@1');
    const call = ChatToolCallEvent.parse(contract('chat_tool_call_event'));
    expect(call.name).toBe('query_issues');
    // The tool's arguments, as the model is constrained to produce them, pass the API's check.
    expect(QueryIssuesArgs.parse(call.arguments).project_key).toBe('PAY');
  });

  it('reads a review exactly as the AI service writes it', () => {
    const review = ReviewResponse.parse(contract('review_response'));
    expect(review.findings[0]?.severity).toBe('critical');
    expect(review.promptVersion).toBe('pr_review@1');
  });
});
