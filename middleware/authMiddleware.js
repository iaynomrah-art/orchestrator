import jwt from "jsonwebtoken";
import { UnauthenticatedError } from "../errors/index.js";

export const authenticateUser = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new UnauthenticatedError("Authentication invalid: Token missing or malformed"));
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Attach decoded user payload to request
    req.user = payload;
    next();
  } catch (error) {
    return next(new UnauthenticatedError("Authentication invalid: Invalid or expired token"));
  }
};
