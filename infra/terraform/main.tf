provider "aws" { region = var.region }

locals {
  input_bucket  = "${var.project}-pdf-input"
  output_bucket = "${var.project}-pdf-output"

  jobs_table  = "PdfJobs"
  items_table = "PdfJobItems"

  work_queue_name = "${var.project}-pdf-work-queue"
  work_dlq_name   = "${var.project}-pdf-work-dlq"

  zip_queue_name  = "${var.project}-pdf-zip-queue"
  zip_dlq_name    = "${var.project}-pdf-zip-dlq"

  notify_topic_name = "${var.project}-pdf-events-topic"
  notify_queue_name = "${var.project}-pdf-events-queue"

  ecr_api      = "${var.project}-pdf-api"
  ecr_worker   = "${var.project}-pdf-worker"
  ecr_notifier = "${var.project}-pdf-notifier"
  ecr_zip      = "${var.project}-pdf-zip-worker"
}

# -------------------------
# S3 buckets
# -------------------------
resource "aws_s3_bucket" "input"  { bucket = local.input_bucket }
resource "aws_s3_bucket" "output" { bucket = local.output_bucket }

resource "aws_s3_bucket_public_access_block" "input" {
  bucket                  = aws_s3_bucket.input.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_public_access_block" "output" {
  bucket                  = aws_s3_bucket.output.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Cost control: expire uploads after 1 day
resource "aws_s3_bucket_lifecycle_configuration" "input_lc" {
  bucket = aws_s3_bucket.input.id
  rule {
    id     = "expire-uploads"
    status = "Enabled"
    expiration { days = 1 }
  }
}

# Cost control: expire outputs after 30 days
resource "aws_s3_bucket_lifecycle_configuration" "output_lc" {
  bucket = aws_s3_bucket.output.id
  rule {
    id     = "expire-outputs"
    status = "Enabled"
    expiration { days = 30 }
  }
}

# Cost control: expire ZIPs after 7 days
resource "aws_s3_bucket_lifecycle_configuration" "zip_lc" {
  bucket = aws_s3_bucket.output.id
  rule {
    id     = "expire-zips"
    status = "Enabled"
    filter { prefix = "zips/" }
    expiration { days = 7 }
  }
}

# -------------------------
# SQS work queue + DLQ
# -------------------------
resource "aws_sqs_queue" "work_dlq" { name = local.work_dlq_name }

resource "aws_sqs_queue" "work_q" {
  name                       = local.work_queue_name
  visibility_timeout_seconds = 180
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.work_dlq.arn
    maxReceiveCount     = 5
  })
}

# -------------------------
# SQS zip queue + DLQ
# -------------------------
resource "aws_sqs_queue" "zip_dlq" { name = local.zip_dlq_name }

resource "aws_sqs_queue" "zip_q" {
  name                       = local.zip_queue_name
  visibility_timeout_seconds = 300
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.zip_dlq.arn
    maxReceiveCount     = 5
  })
}

# -------------------------
# SNS topic + notify SQS queue (SNS -> SQS)
# -------------------------
resource "aws_sns_topic" "events" { name = local.notify_topic_name }
resource "aws_sqs_queue" "notify_q" { name = local.notify_queue_name }

data "aws_iam_policy_document" "notify_q_policy" {
  statement {
    effect = "Allow"
    principals { type = "Service", identifiers = ["sns.amazonaws.com"] }
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.notify_q.arn]
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.events.arn]
    }
  }
}
resource "aws_sqs_queue_policy" "notify_q_policy" {
  queue_url = aws_sqs_queue.notify_q.id
  policy    = data.aws_iam_policy_document.notify_q_policy.json
}

resource "aws_sns_topic_subscription" "events_to_sqs" {
  topic_arn = aws_sns_topic.events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.notify_q.arn
}

# -------------------------
# DynamoDB tables
# -------------------------
resource "aws_dynamodb_table" "jobs" {
  name         = local.jobs_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"
  attribute { name = "jobId", type = "S" }
}

resource "aws_dynamodb_table" "items" {
  name         = local.items_table
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"
  range_key    = "itemId"
  attribute { name = "jobId", type = "S" }
  attribute { name = "itemId", type = "S" }
}

# -------------------------
# ECR repos (store container images)
# -------------------------
resource "aws_ecr_repository" "api"      { name = local.ecr_api }
resource "aws_ecr_repository" "worker"   { name = local.ecr_worker }
resource "aws_ecr_repository" "notifier" { name = local.ecr_notifier }
resource "aws_ecr_repository" "zip"      { name = local.ecr_zip }

# -------------------------
# VPC + EKS (modules)
# -------------------------
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.project}-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.region}a", "${var.region}b"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = true

  tags = { Project = var.project }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = "1.29"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  enable_cluster_creator_admin_permissions = true

  eks_managed_node_groups = {
    ng1 = {
      instance_types = ["t3.large"]
      desired_size   = 2
      min_size       = 2
      max_size       = 10
    }
  }

  tags = { Project = var.project }
}

# -------------------------
# IRSA roles (least privilege pod roles)
# -------------------------
data "aws_iam_policy_document" "api_policy_doc" {
  statement {
    effect    = "Allow"
    actions   = ["sqs:SendMessage","sqs:SendMessageBatch"]
    resources = [aws_sqs_queue.work_q.arn, aws_sqs_queue.zip_q.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:GetItem","dynamodb:Query","dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.jobs.arn, aws_dynamodb_table.items.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject","s3:AbortMultipartUpload","s3:ListBucketMultipartUploads"]
    resources = ["${aws_s3_bucket.input.arn}/*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.output.arn}/*"]
  }
}
resource "aws_iam_policy" "api_policy" {
  name   = "${var.project}-api-policy"
  policy = data.aws_iam_policy_document.api_policy_doc.json
}

data "aws_iam_policy_document" "worker_policy_doc" {
  statement {
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:ChangeMessageVisibility","sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.work_q.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["dynamodb:GetItem","dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.jobs.arn, aws_dynamodb_table.items.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.input.arn}/*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject","s3:HeadObject"]
    resources = ["${aws_s3_bucket.output.arn}/*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]
  }
}
resource "aws_iam_policy" "worker_policy" {
  name   = "${var.project}-worker-policy"
  policy = data.aws_iam_policy_document.worker_policy_doc.json
}

data "aws_iam_policy_document" "notifier_policy_doc" {
  statement {
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage","sqs:DeleteMessage"]
    resources = [aws_sqs_queue.notify_q.arn]
  }
}
resource "aws_iam_policy" "notifier_policy" {
  name   = "${var.project}-notifier-policy"
  policy = data.aws_iam_policy_document.notifier_policy_doc.json
}

data "aws_iam_policy_document" "zip_policy_doc" {
  statement {
    effect    = "Allow"
    actions   = ["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:ChangeMessageVisibility","sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.zip_q.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["dynamodb:GetItem","dynamodb:UpdateItem","dynamodb:Query"]
    resources = [aws_dynamodb_table.jobs.arn, aws_dynamodb_table.items.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject","s3:HeadObject","s3:PutObject"]
    resources = ["${aws_s3_bucket.output.arn}/*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]
  }
}
resource "aws_iam_policy" "zip_policy" {
  name   = "${var.project}-zip-policy"
  policy = data.aws_iam_policy_document.zip_policy_doc.json
}

module "api_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${var.project}-api-irsa"
  attach_policies  = true
  role_policy_arns = { api = aws_iam_policy.api_policy.arn }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["pdf:pdf-api-sa"]
    }
  }
}

module "worker_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${var.project}-worker-irsa"
  attach_policies  = true
  role_policy_arns = { worker = aws_iam_policy.worker_policy.arn }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["pdf:pdf-worker-sa"]
    }
  }
}

module "notifier_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${var.project}-notifier-irsa"
  attach_policies  = true
  role_policy_arns = { notifier = aws_iam_policy.notifier_policy.arn }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["pdf:pdf-notifier-sa"]
    }
  }
}

module "zip_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${var.project}-zip-irsa"
  attach_policies  = true
  role_policy_arns = { zip = aws_iam_policy.zip_policy.arn }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["pdf:pdf-zip-sa"]
    }
  }
}
