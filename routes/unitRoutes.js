import express from "express";
import { getAllUnits, pingUnits } from "../controller/unitController.js";

const router = express.Router();

router.get("/", getAllUnits);
router.post("/ping", pingUnits);

export default router;
