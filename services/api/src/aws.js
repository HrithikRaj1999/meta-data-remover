/**
 * AWS client init for API.
 * - In EKS we use IRSA (IAM Role for Service Account), so NO static credentials here.
 * - AWS SDK automatically reads pod identity credentials.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const REGION = process.env.AWS_REGION;

export const s3 = new S3Client({ region: REGION });
export const sqs = new SQSClient({ region: REGION });

// DocumentClient makes DynamoDB reads/writes use plain JS objects (simpler)
export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION })
);
