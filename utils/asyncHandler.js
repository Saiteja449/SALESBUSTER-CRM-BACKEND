/**
 * Higher-order function to wrap asynchronous Express route handlers,
 * forwarding any unhandled exceptions to the centralized error middleware.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
