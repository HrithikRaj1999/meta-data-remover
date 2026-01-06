/**
 * API SERVICE
 *
 * What this service does (high level):
 * 1) Presign S3 uploads so browser uploads directly to S3 (no API file proxying).
 * 2) Create Job + Item rows in DynamoDB.
 * 3) Enqueue SQS messages (1 per file) so many workers can process in parallel.
 * 4) Presign downloads so S3 stays private (short-lived signed URLs).
 * 5) Enqueue ZIP build jobs to zip queue.
 *
 * ALB path routing note:
 * - Many teams route traffic like:
 *     /api/*     -> API service
 *     /notify/*  -> Notifier service
 * - To avoid needing “rewrite rules”, we mount routes at BOTH "/" and "/api".
 */

import express from "express";
import cors from "cors";
import path from "path";
import { nanoid } from "nanoid";

import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import {
  PutCommand,
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { s3, sqs, ddb } from "./aws.js";
import { PresignSchema, CreateJobSchema } from "./validate.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 4000,
  INPUT_BUCKET,
  OUTPUT_BUCKET,
  WORK_QUEUE_URL,
  ZIP_QUEUE_URL,
  JOBS_TABLE,
  ITEMS_TABLE,
  FRONTEND_URLS,
} = process.env;

function must(name) {
  if (!process.env[name]) throw new Error(`Missing env: ${name}`);
}
[
  "AWS_REGION",
  "INPUT_BUCKET",
  "OUTPUT_BUCKET",
  "WORK_QUEUE_URL",
  "ZIP_QUEUE_URL",
  "JOBS_TABLE",
  "ITEMS_TABLE",
].forEach(must);

/**
 * CORS allowlist:
 * - In production, you should NOT use "*".
 * - We allow only the domains you provide in FRONTEND_URLS.
 */
const allowlist = (FRONTEND_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server without Origin
      if (allowlist.length === 0)
        return cb(new Error("CORS not configured"), false);
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
  })
);

const router = express.Router();

router.get("/health", (req, res) => res.json({ ok: true }));

/** filename sanitization prevents weird chars in S3 keys */
function sanitizeName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

/**
 * download key guard:
 * - prevents key traversal attempts
 * - allows only outputs/ and zips/
 */
function assertSafeKey(key) {
  if (!key || typeof key !== "string") return false;
  if (key.includes("..")) return false;
  if (key.startsWith("/") || key.startsWith("\\")) return false;
  if (!(key.startsWith("outputs/") || key.startsWith("zips/"))) return false;
  return true;
}

/**
 * POST /presign/upload
 * - Validates only PDF uploads
 * - Returns { key, url } for S3 presigned PUT
 *
 * Why:
 * - Browser uploads huge PDFs directly to S3.
 * - API remains fast and cheap.
 */
router.post("/presign/upload", async (req, res) => {
  try {
    const { fileName, contentType } = PresignSchema.parse(req.body);

    // Strict check
    const ext = path.extname(fileName).toLowerCase();
    if (ext !== ".pdf" || contentType !== "application/pdf") {
      return res.status(400).json({ error: "Only .pdf files allowed" });
    }

    const key = `uploads/${Date.now()}-${nanoid(10)}-${sanitizeName(fileName)}`;

    const cmd = new PutObjectCommand({
      Bucket: INPUT_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 600 });
    res.json({ key, url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /jobs
 * - creates job record and item records
 * - enqueues 1 SQS message per item (batching in groups of 10)
 *
 * Why:
 * - One message per file allows horizontal scaling:
 *   more worker pods = more throughput.
 */
router.post("/jobs", async (req, res) => {
  try {
    const { userId, items } = CreateJobSchema.parse(req.body);

    const jobId = `job_${Date.now()}_${nanoid(10)}`;
    const createdAt = new Date().toISOString();

    // Create job row
    await ddb.send(
      new PutCommand({
        TableName: JOBS_TABLE,
        Item: {
          jobId,
          userId,
          createdAt,
          itemsTotal: items.length,
          itemsDone: 0,
          status: "QUEUED",
          zipStatus: "NONE",
          zipKey: null,
          zipError: null,
        },
      })
    );

    // Create items rows (DDB BatchWrite limit = 25)
    const putRequests = items.map((it, idx) => {
      const itemId = String(idx).padStart(6, "0");
      const fileName = sanitizeName(
        it.inputKey.split("/").pop() || `file_${itemId}.pdf`
      );

      return {
        PutRequest: {
          Item: {
            jobId,
            itemId,
            inputKey: it.inputKey,
            outputKey: `outputs/${jobId}/${fileName}`,
            operation: it.operation,
            edit: it.edit || null,
            status: "QUEUED",
            error: null,
            createdAt,
          },
        },
      };
    });

    for (let i = 0; i < putRequests.length; i += 25) {
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [ITEMS_TABLE]: putRequests.slice(i, i + 25) },
        })
      );
    }

    // SQS batch limit = 10
    const messages = items.map((_, idx) => {
      const itemId = String(idx).padStart(6, "0");
      return {
        Id: itemId,
        MessageBody: JSON.stringify({
          jobId,
          itemId,
          inputBucket: INPUT_BUCKET,
          outputBucket: OUTPUT_BUCKET,
        }),
      };
    });

    for (let i = 0; i < messages.length; i += 10) {
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: WORK_QUEUE_URL,
          Entries: messages.slice(i, i + 10),
        })
      );
    }

    res.json({ jobId });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /jobs/:jobId
 * - useful for refresh/debug
 * - main UX uses SSE events, but this lets UI rehydrate state.
 */
router.get("/jobs/:jobId", async (req, res) => {
  const jobId = req.params.jobId;
  const r = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } })
  );
  if (!r.Item) return res.status(404).json({ error: "Not found" });
  res.json(r.Item);
});

/**
 * GET /jobs/:jobId/items
 * - item list with pagination
 */
router.get("/jobs/:jobId/items", async (req, res) => {
  const jobId = req.params.jobId;
  const limit = Math.min(Number(req.query.limit || 200), 200);
  const lastKey = req.query.lastKey
    ? JSON.parse(String(req.query.lastKey))
    : undefined;

  const q = await ddb.send(
    new QueryCommand({
      TableName: ITEMS_TABLE,
      KeyConditionExpression: "jobId = :j",
      ExpressionAttributeValues: { ":j": jobId },
      Limit: limit,
      ExclusiveStartKey: lastKey,
    })
  );

  res.json({ items: q.Items || [], lastKey: q.LastEvaluatedKey || null });
});

/**
 * POST /presign/download
 * - returns presigned GET for output pdf/zip
 * Why:
 * - keep S3 private, no public buckets
 */
router.post("/presign/download", async (req, res) => {
  const key = req.body?.key;
  if (!assertSafeKey(key))
    return res.status(400).json({ error: "Invalid key" });

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: OUTPUT_BUCKET, Key: key }),
    { expiresIn: 600 }
  );

  res.json({ url });
});

/**
 * POST /jobs/:jobId/zip/request
 * - enqueue zip build request (async)
 * Why:
 * - zip for 1000+ files can take time
 * - do not block API / browser
 */
router.post("/jobs/:jobId/zip/request", async (req, res) => {
  const jobId = req.params.jobId;

  const r = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } })
  );
  if (!r.Item) return res.status(404).json({ error: "Not found" });

  if (r.Item.status !== "DONE") {
    return res.status(400).json({ error: "Job not completed yet" });
  }

  if (r.Item.zipStatus === "READY" && r.Item.zipKey) {
    return res.json({ zipStatus: "READY", zipKey: r.Item.zipKey });
  }

  const zipKey = `zips/${jobId}.zip`;

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET zipStatus = :q, zipKey = :k, zipError = :e",
      ExpressionAttributeValues: {
        ":q": "QUEUED",
        ":k": zipKey,
        ":e": null,
      },
    })
  );

  await sqs.send(
    new SendMessageBatchCommand({
      QueueUrl: ZIP_QUEUE_URL,
      Entries: [{ Id: "zip", MessageBody: JSON.stringify({ jobId }) }],
    })
  );

  res.json({ zipStatus: "QUEUED", zipKey });
});

/**
 * GET /jobs/:jobId/zip/presign
 * - only if zipStatus READY
 */
router.get("/jobs/:jobId/zip/presign", async (req, res) => {
  const jobId = req.params.jobId;
  const r = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } })
  );
  if (!r.Item) return res.status(404).json({ error: "Not found" });

  if (r.Item.zipStatus !== "READY" || !r.Item.zipKey) {
    return res.status(400).json({ error: "ZIP not ready" });
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: OUTPUT_BUCKET, Key: r.Item.zipKey }),
    { expiresIn: 600 }
  );

  res.json({ url });
});

// Mount routes at "/" AND "/api" so ALB can route without rewrite
app.use("/", router);
app.use("/api", router);

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
