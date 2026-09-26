import {
  applyDecorators,
  BadRequestException,
  Body,
  type PipeTransform,
  Query,
} from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Validates and parses input with a Zod schema. Failures become a 400 problem+json whose
 * `errors[]` names each invalid field, the shape the web app maps back onto form fields.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException({
      message: 'Validation failed',
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    });
  }
}

/** Request body parsed with `schema`, documented in OpenAPI from the same schema. */
export function ZodBody(schema: z.ZodType): ParameterDecorator {
  return Body(new ZodValidationPipe(schema));
}

/** Query string parsed with `schema`. */
export function ZodQuery(schema: z.ZodType): ParameterDecorator {
  return Query(new ZodValidationPipe(schema));
}

/** OpenAPI request-body documentation generated from a Zod schema (method decorator). */
export function ApiZodBody(schema: z.ZodType): MethodDecorator {
  return applyDecorators(
    ApiBody({ schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as object }),
  );
}
