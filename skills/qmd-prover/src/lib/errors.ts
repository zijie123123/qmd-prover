export interface ErrorLike {
  message?: string;
  stack?: string;
  code?: string | number;
  exitCode?: number;
  [key: string]: unknown;
}

export function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? error as ErrorLike : { message: String(error) };
}

export function errorMessage(error: unknown): string {
  return asErrorLike(error).message ?? String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return asErrorLike(error).code === code;
}
