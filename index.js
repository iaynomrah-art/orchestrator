import express from "express";
import "dotenv/config";
import { supabase } from "./config/supabase.js";
import unitRouter from "./routes/unitRoutes.js";
import { authenticateUser } from "./middleware/authMiddleware.js";
import { notFound } from "./middleware/notFoundMiddleware.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Parsers
app.use(express.json());

// Global Authentication Middleware
app.use(authenticateUser);

// Routes
app.get("/", (req, res) => {
  res.send("Hello Zybryx, Express is running with pnpm + Supabase!");
});

app.use("/api/v1/units", unitRouter);

// Error Middlewares
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
