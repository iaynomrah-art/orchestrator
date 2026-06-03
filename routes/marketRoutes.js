import express from "express";
import { getMarketForecast, getSupportResistance } from "../controller/marketController.js";

const router = express.Router();

// Support both /forecast and /signal endpoints
router.get("/forecast", getMarketForecast);
router.get("/signal", getMarketForecast);
router.get("/levels", getSupportResistance);

export default router;
