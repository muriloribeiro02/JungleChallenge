#!/usr/bin/env bash
set -euo pipefail

echo "Waiting for LocalStack SQS..."
until awslocal sqs list-queues >/dev/null 2>&1; do
  sleep 1
done

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# --- Fila de eventos (outbox → consumers de domínio). Standard local
# (contrato cita .fifo para inbound; eventos continuam standard — ver ARCHITECTURE).
EVENTS_DLQ_URL=$(awslocal sqs create-queue \
  --queue-name jungle-wager-events-dlq \
  --attributes VisibilityTimeout=30 \
  --query 'QueueUrl' --output text)

EVENTS_DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$EVENTS_DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

EVENTS_URL=$(awslocal sqs create-queue \
  --queue-name jungle-wager-events \
  --attributes "{
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${EVENTS_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" \
  --query 'QueueUrl' --output text)

# --- Inbound WagerTransactionRequested — FIFO conforme contrato §10
INBOUND_DLQ_URL=$(awslocal sqs create-queue \
  --queue-name jungle-wager-transactions-dlq.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"true\",
    \"VisibilityTimeout\": \"30\"
  }" \
  --query 'QueueUrl' --output text)

INBOUND_DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$INBOUND_DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

INBOUND_URL=$(awslocal sqs create-queue \
  --queue-name jungle-wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"true\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${INBOUND_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" \
  --query 'QueueUrl' --output text)

echo "SQS EVENTS:  $EVENTS_URL"
echo "SQS EVENTS DLQ: $EVENTS_DLQ_URL"
echo "SQS INBOUND FIFO: $INBOUND_URL"
echo "SQS INBOUND DLQ:  $INBOUND_DLQ_URL"
echo "Region:   $REGION"
