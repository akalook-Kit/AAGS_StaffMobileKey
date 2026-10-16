export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export const forbidden = (m = 'You do not have permission for this action.') => new ApiError(403, 'FORBIDDEN', m);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found.`);
export const badRequest = (code: string, m: string, details?: unknown) => new ApiError(400, code, m, details);
export const conflict = (code: string, m: string) => new ApiError(409, code, m);
