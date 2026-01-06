output "cluster_name" { value = module.eks.cluster_name }

output "input_bucket"  { value = aws_s3_bucket.input.bucket }
output "output_bucket" { value = aws_s3_bucket.output.bucket }

output "work_queue_url" { value = aws_sqs_queue.work_q.url }
output "zip_queue_url"  { value = aws_sqs_queue.zip_q.url }
output "notify_queue_url" { value = aws_sqs_queue.notify_q.url }

output "jobs_table"  { value = aws_dynamodb_table.jobs.name }
output "items_table" { value = aws_dynamodb_table.items.name }

output "sns_topic_arn" { value = aws_sns_topic.events.arn }

output "ecr_api"      { value = aws_ecr_repository.api.repository_url }
output "ecr_worker"   { value = aws_ecr_repository.worker.repository_url }
output "ecr_notifier" { value = aws_ecr_repository.notifier.repository_url }
output "ecr_zip"      { value = aws_ecr_repository.zip.repository_url }

output "api_irsa_role_arn" { value = module.api_irsa.iam_role_arn }
output "worker_irsa_role_arn" { value = module.worker_irsa.iam_role_arn }
output "notifier_irsa_role_arn" { value = module.notifier_irsa.iam_role_arn }
output "zip_irsa_role_arn" { value = module.zip_irsa.iam_role_arn }
