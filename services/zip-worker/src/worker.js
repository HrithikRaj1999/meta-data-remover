/**
 * ZIP WORKER (FULLY COMMENTED)
 *
 * Why separate worker:
 * - ZIP generation is heavy and can take time for 1000+ files.
 * - We want async, scalable behavior.
 *
 * Key trick:
 * - Stream ZIP directly to S3 using multipart upload (no huge temp zip file).
 *
 * Flow:
 * 1) Receive jobId from ZIP queue
 * 2) Validate job DONE
 * 3) Set job.zipStatus PROCESSING
 * 4) Query job items, take DONE outputs
 * 5) Create ZIP stream with archiver
 * 6) Pipe ZIP stream into S3 multipart upload via Upload()
 * 7) Mark job.zipStatus READY
 * 8) Publish SNS ZIP_READY event (UI receives via SSE)
 */

import archiver from "archiver";
import { PassThrough } from "stream";

import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { PublishCommand } from "@aws-sdk/client-sns";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Upload } from "@aws-sdk/lib-storage";

import { s3, sqs, sns, ddb } from "./aws.js";

const {
  ZIP_QUEUE_URL,
  OUTPUT_BUCKET,
  JOBS_TABLE,
  ITEMS_TABLE,
  SNS_TOPIC_ARN,
  VISIBILITY_TIMEOUT_SEC = "300",
  HEARTBEAT_EVERY_SEC = "60",
} = process.env;

function must(name) {
  if (!process.env[name]) throw new Error(`Missing env ${name}`);
}
[
  "AWS_REGION",
  "ZIP_QUEUE_URL",
  "OUTPUT_BUCKET",
  "JOBS_TABLE",
  "ITEMS_TABLE",
  "SNS_TOPIC_ARN",
].forEach(must);

const VIS_TIMEOUT = Number(VISIBILITY_TIMEOUT_SEC);
const HEARTBEAT = Math.min(
  Number(HEARTBEAT_EVERY_SEC),
  Math.max(10, VIS_TIMEOUT - 20)
);

async function publishEvent(evt) {
  await sns.send(
    new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Message: JSON.stringify(evt),
    })
  );
}

async function zipExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: OUTPUT_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * DynamoDB Query pagination:
 * - Query returns up to 1MB per page
 * - for 1000+ items, we loop until lastKey is empty
 */
async function listAllItemsForJob(jobId) {
  let lastKey = undefined;
  const all = [];

  do {
    const q = await ddb.send(
      new QueryCommand({
        TableName: ITEMS_TABLE,
        KeyConditionExpression: "jobId = :j",
        ExpressionAttributeValues: { ":j": jobId },
        ExclusiveStartKey: lastKey,
      })
    );

    if (q.Items) all.push(...q.Items);
    lastKey = q.LastEvaluatedKey;
  } while (lastKey);

  return all;
}

async function setZipStatus(jobId, zipStatus, zipKey = null, zipError = null) {
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: "SET zipStatus = :s, zipKey = :k, zipError = :e",
      ExpressionAttributeValues: {
        ":s": zipStatus,
        ":k": zipKey,
        ":e": zipError,
      },
    })
  );
}

async function processZipMessage(payload) {
  const { jobId } = payload;

  // 1) fetch job
  const jobResp = await ddb.send(
    new GetCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
    })
  );
  const job = jobResp.Item;
  if (!job) throw new Error("Job not found");

  // 2) only zip completed job
  if (job.status !== "DONE") throw new Error("Job not DONE yet");

  const zipKey = job.zipKey || `zips/${jobId}.zip`;

  // Idempotency:
  if (job.zipStatus === "READY" && zipKey && (await zipExists(zipKey))) {
    return;
  }

  // 3) mark PROCESSING
  await setZipStatus(jobId, "PROCESSING", zipKey, null);
  await publishEvent({ type: "ZIP_PROCESSING", jobId, zipKey });

  // 4) list items
  const items = await listAllItemsForJob(jobId);
  const done = items.filter((it) => it.status === "DONE" && it.outputKey);

  if (done.length === 0) throw new Error("No DONE items to zip");

  // 5) zip stream setup
  const archive = archiver("zip", { zlib: { level: 9 } });
  const pass = new PassThrough();

  // 6) start multipart upload to S3
  const uploader = new Upload({
    client: s3,
    params: {
      Bucket: OUTPUT_BUCKET,
      Key: zipKey,
      Body: pass,
      ContentType: "application/zip",
    },
  });

  // pipe zip bytes into pass-through -> S3 uploader
  archive.pipe(pass);

  // 7) append each output pdf as zip entry (sequential to keep memory stable)
  for (const it of done) {
    const key = it.outputKey;
    const fileName = String(key).split("/").pop() || `${it.itemId}.pdf`;

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: OUTPUT_BUCKET, Key: key })
    );
    archive.append(obj.Body, { name: fileName });
  }

  // 8) finalize zip stream
  await archive.finalize();

  // 9) wait upload done
  await uploader.done();

  // 10) mark READY
  await setZipStatus(jobId, "READY", zipKey, null);
  await publishEvent({ type: "ZIP_READY", jobId, zipKey, files: done.length });
}

async function main() {
  console.log("ZIP Worker started...");

  while (true) {
    const resp = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: ZIP_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: VIS_TIMEOUT,
      })
    );

    const msg = resp.Messages?.[0];
    if (!msg) continue;

    const payload = JSON.parse(msg.Body);

    // heartbeat for long zip
    const heartbeatTimer = setInterval(async () => {
      try {
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: ZIP_QUEUE_URL,
            ReceiptHandle: msg.ReceiptHandle,
            VisibilityTimeout: VIS_TIMEOUT,
          })
        );
      } catch (e) {
        console.error("ZIP heartbeat failed:", e?.message || e);
      }
    }, HEARTBEAT * 1000);

    try {
      await processZipMessage(payload);

      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: ZIP_QUEUE_URL,
          ReceiptHandle: msg.ReceiptHandle,
        })
      );
    } catch (err) {
      const jobId = payload?.jobId;
      const message = String(err?.message || err);
      console.error("ZIP Worker error:", message);

      if (jobId) {
        try {
          await setZipStatus(jobId, "FAILED", `zips/${jobId}.zip`, message);
          await publishEvent({ type: "ZIP_FAILED", jobId, error: message });
        } catch {}
      }
      // do not delete => retry/DLQ
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
