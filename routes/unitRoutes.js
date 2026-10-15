import express from "express";
import { getAllUnits, pingUnits, pingSingleUnit, broadcastToUnitAction, pairUnitsAction, executePairAction, forceClosePairAction, getPairQuote } from "../controller/unitController.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

// Apply auth middleware to all routes in this router
router.use(authenticateUser);

router.get("/", getAllUnits);
router.post("/ping", pingUnits);
router.get("/ping/:unit_id", pingSingleUnit);
router.post("/ping/:unit_id", pingSingleUnit);
router.post("/broadcast", broadcastToUnitAction);
router.post("/pair", pairUnitsAction);
router.post("/pair/execute", executePairAction);
router.post("/pair/force-close", forceClosePairAction);
router.post("/quote-pair", getPairQuote);

export default router;
