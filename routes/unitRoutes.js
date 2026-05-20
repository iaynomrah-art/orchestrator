import express from "express";
import { getAllUnits, pingUnits, pingSingleUnit, broadcastToUnitAction, pairUnitsAction } from "../controller/unitController.js";
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

export default router;
