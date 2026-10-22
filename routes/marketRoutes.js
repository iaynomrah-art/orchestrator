import express from "express";
import { getMarketForecast, getSupportResistance, getCurrentPrice, getShadowResults, getSizingVolatility, getShadowStatus } from "../controller/marketController.js";

const router = express.Router();

// Support both /forecast and /signal endpoints
router.get("/forecast", getMarketForecast);
router.get("/signal", getMarketForecast);
router.get("/levels", getSupportResistance);
router.get("/price", getCurrentPrice);
router.get("/shadow-results", getShadowResults);
router.get("/volatility", getSizingVolatility);
router.get("/shadow-status", getShadowStatus);

export default router;
