import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiError } from './api';

/**
 * Maps an API error onto the form: field errors (problem+json `errors[]`) go under their
 * inputs; anything else becomes the form-level message returned for display.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[],
): string | null {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';

  let unmatched = false;
  for (const fieldError of error.problem?.errors ?? []) {
    const field = fields.find((name) => name === fieldError.path);
    if (field) setError(field, { message: fieldError.message });
    else unmatched = true;
  }
  if (error.problem?.errors?.length && !unmatched) return null;

  if (error.status === 429) return error.message;
  if (error.status >= 500) return 'The server had a problem. Please try again.';
  return error.problem?.detail ?? error.message;
}
