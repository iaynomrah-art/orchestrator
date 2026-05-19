import express from "express";
import { getAllUnits, pingUnits } from "../controller/unitController.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

// Apply auth middleware to all routes in this router
router.use(authenticateUser);

router.get("/", getAllUnits);
router.post("/ping", pingUnits);

export default router;
