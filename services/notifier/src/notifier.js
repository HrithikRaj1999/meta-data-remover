/**
 * NOTIFIER SERVICE (SSE)
 *
 * Goal:
 * - replace UI polling with server push.
 *
 * How:
 * - Worker publishes SNS events
 * - SNS pushes to SQS (subscription)
 * - Notifier consumes SQS and sends to connected browsers via SSE
 *
 * ALB path routing:
 * - mount at "/" and "/notify"
 */

import express from "express";
import cors from "cors";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { sqs } from "./aws.js";

const app = express();

const { PORT = 4010, FRONTEND_URLS, NOTIFY_QUEUE_URL } = process.env;

function must(name) {
  if (!process.env[name]) throw new Error(`Missing env ${name}`);
}
["AWS_REGION", "NOTIFY_QUEUE_URL"].forEach(must);

const allowlist = (FRONTEND_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowlist.length === 0)
        return cb(new Error("CORS not configured"), false);
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
  })
);

const router = express.Router();
router.get("/health", (req, res) => res.json({ ok: true }));

/**
 * subscribers: Map(jobId -> Set(res))
 * Each job has its own subscriber list.
 */
const subscribers = new Map();

function sseWrite(res, evt) {
  res.write(`data: ${JSON.stringify(evt)}\n\n`);
}

/**
 * SSE endpoint:
 * Browser connects with EventSource:
 *   /events?jobId=job_...
 */
router.get("/events", (req, res) => {
  const jobId = String(req.query.jobId || "");
  if (!jobId) return res.status(400).send("jobId required");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
  subscribers.get(jobId).add(res);

  // keepalive: prevents ALB/proxies dropping idle connections
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(ping);
    const set = subscribers.get(jobId);
    if (set) {
      set.delete(res);
      if (set.size === 0) subscribers.delete(jobId);
    }
  });

  sseWrite(res, { type: "CONNECTED", jobId });
});

/**
 * SNS->SQS envelope unwrapping:
 * When SNS delivers to SQS, message body is JSON envelope:
 *   { Message: "...original SNS Message string..." }
 */
function unwrapSnsEnvelope(sqsBody) {
  const env = JSON.parse(sqsBody);
  return JSON.parse(env.Message);
}

/**
 * Poll SQS and broadcast events to subscribers.
 * - We always delete events (notification channel; UI can refresh state if missed).
 */
async function pollLoop() {
  console.log("Notifier poll loop started...");

  while (true) {
    const resp = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: NOTIFY_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      })
    );

    const msgs = resp.Messages || [];
    for (const m of msgs) {
      try {
        const evt = unwrapSnsEnvelope(m.Body);
        const jobId = evt.jobId;

        const set = subscribers.get(jobId);
        if (set) for (const res of set) sseWrite(res, evt);

        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: NOTIFY_QUEUE_URL,
            ReceiptHandle: m.ReceiptHandle,
          })
        );
      } catch (e) {
        console.error("Notifier error:", e?.message || e);

        // delete malformed event so it doesn't poison-loop
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: NOTIFY_QUEUE_URL,
            ReceiptHandle: m.ReceiptHandle,
          })
        );
      }
    }
  }
}

pollLoop().catch((e) => {
  console.error(e);
  process.exit(1);
});

app.use("/", router);
app.use("/notify", router);

app.listen(PORT, () => console.log(`Notifier listening on :${PORT}`));
