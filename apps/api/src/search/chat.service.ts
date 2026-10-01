import {
  Citation,
  type ChatMessage,
  type ChatRequest,
  type Conversation,
  type ConversationDetail,
} from '@forge/types';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { AiUsageService } from '../ai/ai-usage.service';
import { AiClient, type ChatTurnInput } from '../ai/ai.client';
import { AiUnavailableException } from '../ai/ai.errors';
import {
  ChatErrorEvent,
  ChatResultEvent,
  ChatToolCallEvent,
  QueryIssuesArgs,
  type WireCitation,
} from '../ai/ai.wire';
import { readSse, sseFrame } from '../ai/sse';
import type { AuthUser } from '../auth/auth.types';
import type { AiMessage } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { describeQuery, queryIssues, type ReadableProject } from './query-issues';
import { SearchService } from './search.service';

/** Earlier turns sent with each question, for follow-ups ("and who fixed it?"). */
const HISTORY_MESSAGES = 10;
const TITLE_LENGTH = 80;

/**
 * FR-7.4 (architecture §7.3): a question answered from retrieved project data, streamed, with
 * cited sources. The API decides scope (the user's readable projects, checked on every turn),
 * runs the query_issues tool itself when the model asks for it, and stores the conversation.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
    private readonly search: SearchService,
  ) {}

  /** Checks and the first upstream call happen before any byte is sent, so they stay JSON errors. */
  async stream(user: AuthUser, body: ChatRequest, res: Response): Promise<void> {
    if (!this.client.configured) throw new AiUnavailableException();
    await this.usage.assertWithinBudget(user.id);

    const existing = body.conversationId
      ? await this.prisma.aiConversation.findFirst({
          where: { id: body.conversationId, userId: user.id },
        })
      : null;
    if (body.conversationId && !existing) throw new NotFoundException('Conversation not found');
    // A conversation keeps the scope it started with; access is re-checked every turn.
    const scope = existing ? (existing.projectId ?? undefined) : body.projectId;
    const projects = await this.search.readableProjects(user, scope);

    const history = existing
      ? (
          await this.prisma.aiMessage.findMany({
            where: { conversationId: existing.id, role: { in: ['USER', 'ASSISTANT'] } },
            orderBy: { createdAt: 'desc' },
            take: HISTORY_MESSAGES,
            select: { role: true, content: true },
          })
        ).reverse()
      : [];
    const turn: ChatTurnInput = {
      messages: [
        ...history.map((m) => ({
          role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
          content: m.content.slice(0, 8000),
        })),
        { role: 'user', content: body.message },
      ],
      projects: projects.map(({ id, key, name }) => ({ id, key, name })),
    };

    const abort = new AbortController();
    res.on('close', () => {
      abort.abort();
    });
    const started = Date.now();
    let upstream = await this.client.chatStream(turn, abort.signal);

    const conversation =
      existing ??
      (await this.prisma.aiConversation.create({
        data: {
          userId: user.id,
          projectId: body.projectId ?? null,
          title: clip(body.message, TITLE_LENGTH),
        },
      }));
    await this.prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'USER', content: body.message },
    });
    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(sseFrame('conversation', { conversationId: conversation.id }));

    const record = (outcome: z.infer<typeof ChatToolCallEvent> | z.infer<typeof ChatResultEvent>) =>
      this.recordUsage(user.id, conversation.projectId, outcome, started);

    let finished = false;
    try {
      // At most two rounds: the model may call query_issues once, then it must answer.
      for (let round = 0; round < 2 && !finished; round += 1) {
        let next: ReadableStream<Uint8Array> | undefined;
        for await (const event of readSse(upstream)) {
          if (event.event === 'delta') {
            res.write(sseFrame('delta', JSON.parse(event.data) as unknown));
          } else if (event.event === 'tool_call' && round === 0) {
            const call = ChatToolCallEvent.parse(JSON.parse(event.data));
            await record(call);
            // The model's arguments are a request, not a command: validated and then run with
            // this user's projects only. Invalid arguments find nothing rather than fail.
            const args = QueryIssuesArgs.safeParse(call.arguments);
            const result = args.success
              ? await queryIssues(this.prisma, args.data, projects)
              : { total: 0, issues: [] };
            const description = args.success ? describeQuery(args.data) : 'Looking up issues';
            // Kept with the conversation, so a later reader sees where the answer came from.
            await this.prisma.aiMessage.create({
              data: { conversationId: conversation.id, role: 'TOOL', content: description },
            });
            res.write(sseFrame('tool', { name: 'query_issues', description }));
            next = await this.client.chatStream(
              {
                ...turn,
                toolCall: { id: call.id, name: call.name, arguments: call.rawArguments },
                toolResult: result,
              },
              abort.signal,
            );
            break;
          } else if (event.event === 'result') {
            const result = ChatResultEvent.parse(JSON.parse(event.data));
            await record(result);
            const citations = toCitations(result.citations, projects);
            const message = await this.prisma.aiMessage.create({
              data: {
                conversationId: conversation.id,
                role: 'ASSISTANT',
                content: result.answer,
                citations,
                model: result.model.slice(0, 100),
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              },
            });
            res.write(
              sseFrame('result', {
                conversationId: conversation.id,
                messageId: message.id,
                answer: result.answer,
                citations,
              }),
            );
            finished = true;
          } else if (event.event === 'error' || event.event === 'tool_call') {
            const parsed = ChatErrorEvent.safeParse(JSON.parse(event.data));
            const code = parsed.success ? parsed.data.code : 'error';
            res.write(sseFrame('error', { code, message: messageFor(code) }));
            finished = true;
          }
        }
        if (!next) break;
        upstream = next;
      }
    } catch (error) {
      if (!abort.signal.aborted) this.logger.warn(`Chat stream failed: ${String(error)}`);
    }
    if (!finished && !abort.signal.aborted) {
      res.write(sseFrame('error', { code: 'interrupted', message: messageFor('interrupted') }));
    }
    res.end();
  }

  async list(user: AuthUser): Promise<Conversation[]> {
    const rows = await this.prisma.aiConversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return rows.map(toConversation);
  }

  async get(id: string, user: AuthUser): Promise<ConversationDetail> {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id, userId: user.id },
      include: {
        messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return { ...toConversation(conversation), messages: conversation.messages.map(toMessage) };
  }

  async delete(id: string, user: AuthUser): Promise<void> {
    const { count } = await this.prisma.aiConversation.deleteMany({
      where: { id, userId: user.id },
    });
    if (count === 0) throw new NotFoundException('Conversation not found');
  }

  private async recordUsage(
    userId: string,
    projectId: string | null,
    outcome: z.infer<typeof ChatToolCallEvent> | z.infer<typeof ChatResultEvent>,
    started: number,
  ): Promise<void> {
    const latencyMs = Date.now() - started;
    await this.usage.record({
      feature: 'CHAT',
      userId,
      projectId,
      model: outcome.model,
      promptVersion: outcome.promptVersion,
      usage: outcome.usage,
      latencyMs,
      success: true,
    });
    if (outcome.embedding.inputTokens > 0) {
      await this.usage.record({
        feature: 'CHAT',
        userId,
        projectId,
        model: outcome.embedding.model,
        usage: {
          inputTokens: outcome.embedding.inputTokens,
          outputTokens: 0,
          costUsd: outcome.embedding.costUsd,
        },
        latencyMs,
        success: true,
      });
    }
  }
}

/**
 * Citations as the web app shows them. The AI service only retrieves from the projects it was
 * given; dropping anything else here as well means one bug cannot leak another project's title.
 */
function toCitations(citations: WireCitation[], projects: ReadableProject[]): Citation[] {
  const keys = new Map(projects.map((p) => [p.id, p.key]));
  return citations.flatMap((c) =>
    keys.has(c.projectId)
      ? [
          {
            n: c.n,
            sourceType: c.sourceType,
            title: c.title,
            url: c.url,
            projectKey: keys.get(c.projectId) ?? null,
            headingPath: c.headingPath,
          },
        ]
      : [],
  );
}

const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

function toConversation(row: {
  id: string;
  title: string;
  projectId: string | null;
  updatedAt: Date;
}): Conversation {
  return {
    id: row.id,
    title: row.title,
    projectId: row.projectId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessage(row: AiMessage): ChatMessage {
  const citations = z.array(Citation).safeParse(row.citations ?? []);
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations: citations.success ? citations.data : [],
    createdAt: row.createdAt.toISOString(),
  };
}

/** User-facing text: the AI service's own messages can name providers and internals. */
function messageFor(code: string): string {
  switch (code) {
    case 'provider_unavailable':
      return 'The AI provider is busy or unreachable. Please try again in a minute.';
    case 'retrieval_unavailable':
      return "The assistant can't search project data right now. Please try again shortly.";
    case 'interrupted':
      return 'The answer was interrupted. Please try again.';
    default:
      return 'The assistant could not answer. Please try again.';
  }
}
