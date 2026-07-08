import ApiError from '../utils/ApiError.js';

export const notFound = (req, res, next) => {
  next(new ApiError(404, `נתיב לא נמצא: ${req.originalUrl}`));
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  let status = err.statusCode || 500;
  let message = err.message || 'שגיאת שרת';

  if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join(', ');
  } else if (err.name === 'CastError') {
    status = 400;
    message = `ערך לא תקין עבור ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    message = `ערך כפול: ${JSON.stringify(err.keyValue)}`;
  }

  if (status >= 500) console.error('❌', err);
  res.status(status).json({ success: false, message });
};
