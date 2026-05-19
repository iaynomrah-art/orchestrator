import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const secret = process.env.JWT_SECRET || "du28i1lpvuckjmssws5j0thvzxr6vqzm";

// 1. Generate a test token
const payload = { userId: "user_test_123", role: "admin" };
const token = jwt.sign(payload, secret, { expiresIn: "1h" });
console.log("🔑 Generated Test JWT Token:", token);

// 2. Import the authenticateUser middleware and verify it manually
import { authenticateUser } from "./middleware/authMiddleware.js";

const mockReq = {
  headers: {
    authorization: `Bearer ${token}`
  }
};

const mockRes = {};

const mockNext = (err) => {
  if (err) {
    console.error("❌ Auth test failed. Error:", err.message);
  } else {
    console.log("✅ Auth test succeeded! Request user payload attached:", mockReq.user);
  }
};

console.log("\nTesting authenticateUser with VALID token...");
authenticateUser(mockReq, mockRes, mockNext);

console.log("\nTesting authenticateUser with INVALID/MALFORMED token...");
const badReq = {
  headers: {
    authorization: "Bearer wrong_token"
  }
};
authenticateUser(badReq, mockRes, (err) => {
  if (err) {
    console.log("✅ Successfully rejected invalid token, error:", err.message);
  } else {
    console.error("❌ Failed: Authentication should have failed with bad token!");
  }
});

console.log("\nTesting authenticateUser with MISSING token...");
const missingReq = {
  headers: {}
};
authenticateUser(missingReq, mockRes, (err) => {
  if (err) {
    console.log("✅ Successfully rejected missing token, error:", err.message);
  } else {
    console.error("❌ Failed: Authentication should have failed with missing token!");
  }
});
