// HTTP-facing errors. Any thrown error carrying `status` and `code` is rendered as JSON by the
// app's error handler (ConfigError follows the same shape).
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const forbidden = (reason) => new HttpError(403, 'forbidden', reason);
export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required.') => new HttpError(401, 'unauthorized', message);

/** Wrap an async route handler so rejections reach the error handler. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
