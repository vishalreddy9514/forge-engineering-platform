import type { CreateLabelRequest, Label, UpdateLabelRequest } from '@forge/types';
import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../infrastructure/database/prisma.service';
import { LABEL_INCLUDE, toLabel } from './project.mappers';

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
      include: LABEL_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return labels.map(toLabel);
  }

  async create(projectId: string, input: CreateLabelRequest): Promise<Label> {
    try {
      return toLabel(
        await this.prisma.label.create({
          data: { projectId, ...input, description: input.description ?? null },
          include: LABEL_INCLUDE,
        }),
      );
    } catch (error) {
      // Names are citext: "Bug" and "bug" collide.
      if (isUniqueViolation(error)) throw duplicateName(input.name);
      throw error;
    }
  }

  async update(labelId: string, input: UpdateLabelRequest): Promise<Label> {
    try {
      return toLabel(
        await this.prisma.label.update({
          where: { id: labelId },
          data: input,
          include: LABEL_INCLUDE,
        }),
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
