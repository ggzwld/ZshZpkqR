import express from "express";
import cors from "cors";
import { handleDemo } from "./routes/demo";
import {
  createFlutterwaveInlineSession,
  handleFlutterwaveWebhook,
  verifyFlutterwavePayment,
} from "./routes/flutterwave";

export function createServer() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Example API routes
  app.get("/api/ping", (_req, res) => {
    res.json({ message: "Hello from Express server v2!" });
  });

  app.get("/api/demo", handleDemo);
  app.post("/api/payments/flutterwave/inline-session", createFlutterwaveInlineSession);
  app.post("/api/payments/flutterwave/verify", verifyFlutterwavePayment);
  app.post("/api/payments/flutterwave/webhook", handleFlutterwaveWebhook);

  return app;
}
