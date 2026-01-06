Browser (React)
   |
   |--(1) presign upload
   v
API (EKS / Node)
   |
   |-- returns presigned PUT
   v
S3 INPUT BUCKET
   |
   |--(2) create job
   v
DynamoDB (PdfJobs, PdfJobItems)
   |
   |--(3) enqueue messages
   v
SQS WORK QUEUE
   |
   |--(4) consume
   v
WORKER PODS
   |
   |-- download PDF
   |-- remove/edit metadata
   |-- upload result
   v
S3 OUTPUT BUCKET
   |
   |-- update status
   v
DynamoDB
   |
   |-- publish event
   v
SNS
   |
   |-- fanout
   v
SQS NOTIFY QUEUE
   |
   |-- consume
   v
NOTIFIER POD (SSE)
   |
   |-- push live updates
   v
Browser


User clicks "Download ZIP"
 → API enqueues ZIP job
 → ZIP SQS
 → ZIP WORKER
 → stream ZIP → S3
 → SNS event ZIP_READY
 → Browser downloads ZIP