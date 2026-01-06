import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const REGION = process.env.AWS_REGION;

export const s3 = new S3Client({ region: REGION });
export const sqs = new SQSClient({ region: REGION });
export const sns = new SNSClient({ region: REGION });
export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION })
);
