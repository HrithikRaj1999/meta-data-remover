/**
 * WORKER LOGIC 
 *
 * This worker consumes the SQS work queue, one message = one PDF item.
 *
 * Why this design scales:
 * - SQS decouples ingestion from processing.
 * - Add more worker pods (replicas / KEDA) => more throughput.
 * - Each worker is stateless; safe to restart and autoscale.
 *
 * Reliability & fixes:
 * ✅ temp disk cleanup (try/finally)
 * ✅ exiftool/qpdf timeouts (avoid zombies)
 * ✅ heartbeat extends SQS visibility timeout
 * ✅ delete SQS message ONLY after success
 * ✅ conditional updates avoid double-counting DONE
 * ✅ output-exists check provides idempotency
 */

import fs from "fs";
import os from "os";
import path from "path";
import { rm } from "fs/promises";

import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";

import { PublishCommand } from "@aws-sdk/client-sns";
import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { s3, sqs, sns, ddb } from "./aws.js";
import {
  assertPdfMagicHeader,
  removeOrEditMetadata,
  qpdfRewrite,
} from "./pdf.js";

const {
  QUEUE_URL,
  JOBS_TABLE,
  ITEMS_TABLE,
  SNS_TOPIC_ARN,
  VISIBILITY_TIMEOUT_SEC = "180",
  HEARTBEAT_EVERY_SEC = "45",
} = process.env;

function must(name) {
  if (!process.env[name]) throw new Error(`Missing env ${name}`);
}
[
  "AWS_REGION",
  "QUEUE_URL",
  "JOBS_TABLE",
  "ITEMS_TABLE",
  "SNS_TOPIC_ARN",
].forEach(must);

const VIS_TIMEOUT = Number(VISIBILITY_TIMEOUT_SEC);
const HEARTBEAT = Math.min(
  Number(HEARTBEAT_EVERY_SEC),
  Math.max(5, VIS_TIMEOUT - 10)
);

/**
 * streamToFile:
 * - ExifTool and QPDF require filesystem paths,
 *   so we download S3 object stream to local temp disk.
 */
async function streamToFile(bodyStream, filePath) {
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    bodyStream.pipe(w);
    bodyStream.on("error", reject);
    w.on("error", reject);
    w.on("finish", resolve);
  });
}

/**
 * publishEvent:
 * - Workers publish progress events into SNS
 * - Notifier service consumes SNS->SQS and pushes to browser via SSE
 * - This replaces UI polling.
 */
async function publishEvent(evt) {
  await sns.send(
    new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Message: JSON.stringify(evt),
    })
  );
}

/**
 * setItemStatus:
 * - updates PdfJobItems status field
 * - can include extra fields (error)
 * - can include ConditionExpression to prevent overwriting DONE
 */
async function setItemStatus(
  jobId,
  itemId,
  status,
  extra = {},
  condition = null
) {
  const names = { "#s": "status" };
  const values = { ":s": status };
  let expr = "SET #s = :s";

  for (const [k, v] of Object.entries(extra)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    expr += `, #${k} = :${k}`;
  }

  const params = {
    TableName: ITEMS_TABLE,
    Key: { jobId, itemId },
    UpdateExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };

  if (condition) params.ConditionExpression = condition;
  await ddb.send(new UpdateCommand(params));
}

/**
 * incrementJobDone:
 * - increments itemsDone in PdfJobs
 * - uses if_not_exists for safety
 */
async function incrementJobDone(jobId) {
  const updated = await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression:
        "SET itemsDone = if_not_exists(itemsDone,:z) + :inc, #st = :running",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":inc": 1, ":z": 0, ":running": "RUNNING" },
      ReturnValues: "ALL_NEW",
    })
  );
  return updated.Attributes;
}

/**
 * completeJobIfNeeded:
 * - if itemsDone >= itemsTotal, mark job DONE
 * - ConditionExpression prevents race between multiple workers finishing last items
 */
async function completeJobIfNeeded(job) {
  if (!job) return;

  if (job.itemsDone >= job.itemsTotal) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: JOBS_TABLE,
          Key: { jobId: job.jobId },
          UpdateExpression: "SET #st = :done",
          ConditionExpression: "#st <> :done",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: { ":done": "DONE" },
        })
      );

      await publishEvent({
        type: "JOB_DONE",
        jobId: job.jobId,
        itemsTotal: job.itemsTotal,
      });
    } catch {
      // Another worker already set DONE
    }
  }
}

/**
 * outputExists:
 * - idempotency safety:
 *   If a message is redelivered after success, check if output already exists
 *   and avoid reprocessing.
 */
async function outputExists(bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * processMessage:
 * - does the full workflow for one PDF item
 */
async function processMessage(sqsMessage, payload) {
  const { jobId, itemId, inputBucket, outputBucket } = payload;

  // Unique temp directory per message so parallel files never clash
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-"));
  const inPath = path.join(tmpDir, "in.pdf");
  const outPath = path.join(tmpDir, "out.pdf");
  const finalPath = path.join(tmpDir, "final.pdf");

  // heartbeat timer keeps the message invisible while we process it
  let heartbeatTimer = null;

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(async () => {
      try {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: sqsMessage.ReceiptHandle,
            VisibilityTimeout: VIS_TIMEOUT,
          })
        );
      } catch (e) {
        console.error("Heartbeat failed:", e?.message || e);
      }
    }, HEARTBEAT * 1000);
  };

  try {
    startHeartbeat();

    // 1) load item record
    const itemResp = await ddb.send(
      new GetCommand({
        TableName: ITEMS_TABLE,
        Key: { jobId, itemId },
      })
    );
    const item = itemResp.Item;
    if (!item) throw new Error("Item missing in DynamoDB");

    // already done => treat as success (duplicate delivery)
    if (item.status === "DONE") return;

    // if output exists already, mark DONE and skip
    if (await outputExists(outputBucket, item.outputKey)) {
      try {
        await setItemStatus(jobId, itemId, "DONE", {}, "#s <> :done");
      } catch {}
      return;
    }

    // 2) mark PROCESSING
    await setItemStatus(jobId, itemId, "PROCESSING", { error: null });

    // 3) download from S3 input
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: inputBucket, Key: item.inputKey })
    );
    await streamToFile(obj.Body, inPath);

    // 4) validate PDF header
    assertPdfMagicHeader(inPath);

    // 5) remove/edit metadata
    await removeOrEditMetadata({
      inPath,
      outPath,
      operation: item.operation,
      edit: item.edit || undefined,
    });

    // 6) rewrite final PDF
    await qpdfRewrite({ inPath: outPath, outPath: finalPath });

    // 7) upload to output bucket
    await s3.send(
      new PutObjectCommand({
        Bucket: outputBucket,
        Key: item.outputKey,
        Body: fs.createReadStream(finalPath),
        ContentType: "application/pdf",
      })
    );

    // 8) set DONE (with condition)
    let becameDone = false;
    try {
      await setItemStatus(
        jobId,
        itemId,
        "DONE",
        {},
        "attribute_not_exists(#s) OR #s <> :done"
      );
      becameDone = true;
    } catch {
      // already DONE
    }

    // 9) publish event to UI
    await publishEvent({
      type: "ITEM_DONE",
      jobId,
      itemId,
      outputKey: item.outputKey,
    });

    // 10) increment job done count only if we transitioned to DONE now
    if (becameDone) {
      const job = await incrementJobDone(jobId);
      await completeJobIfNeeded(job);
    }
  } catch (err) {
    const message = String(err?.message || err);
    console.error("Worker error:", message);

    // mark FAILED if not done
    try {
      await setItemStatus(
        jobId,
        itemId,
        "FAILED",
        { error: message },
        "#s <> :done"
      );
    } catch {}

    // publish failure event to UI
    try {
      await publishEvent({
        type: "ITEM_FAILED",
        jobId,
        itemId,
        error: message,
      });
    } catch {}

    // rethrow so we DO NOT delete SQS message -> retry -> DLQ eventually
    throw err;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // CRITICAL disk cleanup always (prevents disk leak)
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Poll loop
 * - long polling reduces cost
 * - one message at a time per pod is stable
 * - scale pods horizontally for throughput
 */
async function main() {
  console.log("PDF Worker started...");

  while (true) {
    const resp = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: VIS_TIMEOUT,
      })
    );

    const msg = resp.Messages?.[0];
    if (!msg) continue;

    const payload = JSON.parse(msg.Body);

    try {
      await processMessage(msg, payload);

      // delete message only on success
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: QUEUE_URL,
          ReceiptHandle: msg.ReceiptHandle,
        })
      );
    } catch {
      // no delete => retry
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
