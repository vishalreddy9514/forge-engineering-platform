import {
  ChatRequest,
  type Conversation,
  type ConversationDetail,
  CreateDocumentRequest,
  type ProjectDocument,
  type ProjectDocumentDetail,
  RelatedDraftRequest,
  type RelatedIssuesResponse,
  SemanticSearchQuery,
  type SemanticSearchResponse,
} from '@forge/types';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import { AdminGuard } from '../admin/admin.guard';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/http/zod';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { ChatService } from './chat.service';
import { DocumentsService } from './documents.service';
import { IndexingJobs } from './indexing.jobs';
import { SearchService } from './search.service';

/** Same budget as the other AI endpoints (architecture §6.5). */
const AI_RATE_LIMIT = { name: 'ai', limit: 20, windowSeconds: 60, by: 'user' } as const;
/** Search is cheaper (one embedding) and typed more often than a chat question is asked. */
const SEARCH_RATE_LIMIT = { name: 'ai-search', limit: 60, windowSeconds: 60, by: 'user' } as const;

@ApiTags('search')
@ApiBearerAuth()
@Controller()
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly chat: ChatService,
  ) {}

  /** FR-11.2. Every project the caller can read, or one with `projectId`. */
  @Get('search/semantic')
  @RateLimit(SEARCH_RATE_LIMIT)
  semantic(
    @ZodQuery(SemanticSearchQuery) query: SemanticSearchQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<SemanticSearchResponse> {
    return this.search.semantic(user, query);
  }

  @Get('issues/:issueId/related')
  @RequireProjectPermission('ai:write', 'issue')
  @RateLimit(SEARCH_RATE_LIMIT)
  async related(
    @Param('issueId') issueId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<RelatedIssuesResponse> {
    return { data: await this.search.relatedToIssue(issueId, user) };
  }

  /** While drafting: possible duplicates of text that is not an issue yet. */
  @Post('projects/:projectId/ai/related')
  @HttpCode(200)
  @RequireProjectPermission('ai:write')
  @RateLimit(SEARCH_RATE_LIMIT)
  @ApiZodBody(RelatedDraftRequest)
  async relatedToDraft(
    @Param('projectId') projectId: string,
    @ZodBody(RelatedDraftRequest) body: RelatedDraftRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<RelatedIssuesResponse> {
    return { data: await this.search.relatedToText(projectId, body.text, user) };
  }

  /** text/event-stream: `conversation`, `delta`*, optional `tool`, then `result` or `error`. */
  @Post('ai/chat')
  @RateLimit(AI_RATE_LIMIT)
  @ApiZodBody(ChatRequest)
  async ask(
    @ZodBody(ChatRequest) body: ChatRequest,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.chat.stream(user, body, res);
  }

  @Get('ai/conversations')
  conversations(@CurrentUser() user: AuthUser): Promise<Conversation[]> {
    return this.chat.list(user);
  }

  @Get('ai/conversations/:conversationId')
  conversation(
    @Param('conversationId', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationDetail> {
    return this.chat.get(id, user);
  }

  @Delete('ai/conversations/:conversationId')
  @HttpCode(204)
  deleteConversation(
    @Param('conversationId', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.chat.delete(id, user);
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('projects/:projectId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequireProjectPermission('project:read')
  list(@Param('projectId') projectId: string): Promise<ProjectDocument[]> {
    return this.documents.list(projectId);
  }

  @Get(':documentId')
  @RequireProjectPermission('project:read')
  get(
    @Param('projectId') projectId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<ProjectDocumentDetail> {
    return this.documents.get(projectId, documentId);
  }

  @Post()
  @RequireProjectPermission('document:write')
  @ApiZodBody(CreateDocumentRequest)
  create(
    @Param('projectId') projectId: string,
    @ZodBody(CreateDocumentRequest) body: CreateDocumentRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectDocument> {
    return this.documents.create(projectId, body, user);
  }

  @Put(':documentId')
  @RequireProjectPermission('document:write')
  @ApiZodBody(CreateDocumentRequest)
  update(
    @Param('projectId') projectId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @ZodBody(CreateDocumentRequest) body: CreateDocumentRequest,
  ): Promise<ProjectDocument> {
    return this.documents.update(projectId, documentId, body);
  }

  @Delete(':documentId')
  @HttpCode(204)
  @RequireProjectPermission('document:write')
  delete(
    @Param('projectId') projectId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<void> {
    return this.documents.delete(projectId, documentId);
  }
}

/** Rebuild the whole index, e.g. after changing the embedding model (OPENAI_EMBEDDING_MODEL). */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/search')
export class SearchAdminController {
  constructor(private readonly jobs: IndexingJobs) {}

  @Post('reindex')
  @HttpCode(202)
  async reindex(): Promise<{ status: 'queued' }> {
    await this.jobs.backfill(true);
    return { status: 'queued' };
  }
}
