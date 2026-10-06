import type { CreateLabelRequest, Label, UpdateLabelRequest } from '@forge/types';
import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../infrastructure/database/prisma.service';
import { toLabel } from './project.mappers';

const duplicateName = (name: string | undefined) =>
  new ConflictException({
    message: 'Validation failed',
    errors: [{ path: 'name', message: `A label named "${name ?? ''}" already exists` }],
  });

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === 'P2002';

@Injectable()
export class LabelsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: string): Promise<Label[]> {
    const labels = await this.prisma.label.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    const counts = await this.prisma.issueLabel.groupBy({
      by: ['labelId'],
      where: { labelId: { in: labels.map((label) => label.id) } },
      _count: { _all: true },
    });
    const byLabel = new Map(counts.map((row) => [row.labelId, row._count._all]));
    return labels.map((label) => toLabel(label, byLabel.get(label.id) ?? 0));
  }

  private async withCount(label: { id: string } & Parameters<typeof toLabel>[0]): Promise<Label> {
    return toLabel(label, await this.prisma.issueLabel.count({ where: { labelId: label.id } }));
  }

  async create(projectId: string, input: CreateLabelRequest): Promise<Label> {
    try {
      // A new label is on no issue yet.
      return toLabel(
        await this.prisma.label.create({
          data: { projectId, ...input, description: input.description ?? null },
        }),
        0,
      );
    } catch (error) {
      // Names are citext: "Bug" and "bug" collide.
      if (isUniqueViolation(error)) throw duplicateName(input.name);
      throw error;
    }
  }

  async update(labelId: string, input: UpdateLabelRequest): Promise<Label> {
    try {
      return await this.withCount(
        await this.prisma.label.update({ where: { id: labelId }, data: input }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateName(input.name);
      throw error;
    }
  }

  /** Removes the label from every issue that uses it (issue_labels cascades). */
  async delete(labelId: string): Promise<void> {
    await this.prisma.label.delete({ where: { id: labelId } });
  }
}
