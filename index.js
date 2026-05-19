import express from "express";
import "dotenv/config";
import cors from "cors";
import { supabase } from "./config/supabase.js";
import unitRouter from "./routes/unitRoutes.js";
import marketRouter from "./routes/marketRoutes.js";
import { requestLogger } from "./middleware/loggerMiddleware.js";
import { notFound } from "./middleware/notFoundMiddleware.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Request Logger
app.use(requestLogger);

// CORS Configuration
const allowedOrigins = [
  "https://app.iaynomrah.cloud",
  "https://app2.iaynomrah.cloud"
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like curl, postman, server-to-server)
      if (!origin) return callback(null, true);
      
      const normalizedOrigin = origin.replace(/\/$/, "");
      if (allowedOrigins.includes(normalizedOrigin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// Parsers
app.use(express.json());

// Routes
app.get("/", (req, res) => {
  res.send("Hello Zybryx, Express is running with pnpm + Supabase!");
});

app.use("/api/v1/units", unitRouter);
app.use("/api/v1/market", marketRouter);

// Error Middlewares
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
