import jwt from "jsonwebtoken";
import { UnauthenticatedError } from "../errors/index.js";

export const authenticateUser = (req, res, next) => {
  // Skip authentication in development mode
  if (process.env.NODE_ENV === "development") {
    return next();
  }

  // Extract token from Authorization header (Bearer) or from cookies (key: token)
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } else if (req.headers.cookie) {
    // simple parsing of cookie header
    const cookies = req.headers.cookie.split(";").reduce((acc, cookie) => {
      const [key, value] = cookie.trim().split("=");
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
    if (cookies.token) {
      token = cookies.token;
    }
  }

  if (!token) {
    return next(new UnauthenticatedError("Authentication invalid: Token missing or malformed"));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Attach decoded user payload to request
    req.user = payload;
    next();
  } catch (error) {
    return next(new UnauthenticatedError("Authentication invalid: Invalid or expired token"));
  }
};
