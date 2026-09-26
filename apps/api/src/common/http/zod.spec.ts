import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from './zod';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(
    z.object({ email: z.email(), age: z.coerce.number().int().min(18) }),
  );

  it('returns the parsed value (with coercion applied)', () => {
    expect(pipe.transform({ email: 'a@b.co', age: '21' })).toEqual({ email: 'a@b.co', age: 21 });
  });

  it('reports every invalid field with its path', () => {
    try {
      pipe.transform({ email: 'nope', age: 3 });
      throw new Error('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as {
        errors: { path: string }[];
      };
      expect(body.errors.map((e) => e.path)).toEqual(['email', 'age']);
    }
  });

  it('strips unknown keys (no mass assignment of fields like isAdmin)', () => {
    expect(pipe.transform({ email: 'a@b.co', age: 30, isAdmin: true })).not.toHaveProperty(
      'isAdmin',
    );
  });
});
