import { SQSClient } from "@aws-sdk/client-sqs";
export const REGION = process.env.AWS_REGION;
export const sqs = new SQSClient({ region: REGION });
