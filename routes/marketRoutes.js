import express from "express";
import { getMarketForecast, getSupportResistance, getCurrentPrice } from "../controller/marketController.js";

const router = express.Router();

// Support both /forecast and /signal endpoints
router.get("/forecast", getMarketForecast);
router.get("/signal", getMarketForecast);
router.get("/levels", getSupportResistance);
router.get("/price", getCurrentPrice);

export default router;
