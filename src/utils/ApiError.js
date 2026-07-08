/** Operational error carrying an HTTP status code. */
export default class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg = 'בקשה שגויה') {
    return new ApiError(400, msg);
  }
  static unauthorized(msg = 'נדרשת התחברות') {
    return new ApiError(401, msg);
  }
  static forbidden(msg = 'אין הרשאה') {
    return new ApiError(403, msg);
  }
  static notFound(msg = 'לא נמצא') {
    return new ApiError(404, msg);
  }
}
