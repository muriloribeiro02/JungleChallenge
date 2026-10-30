#!/usr/bin/env bash
set -euo pipefail

echo "Waiting for LocalStack SQS..."
until awslocal sqs list-queues >/dev/null 2>&1; do
  sleep 1
done

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
# Fonte única de verdade (Compose / .env → LocalStack + sqsEnv na app).
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
if ! [[ "${MAX_RECEIVE_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "SQS_MAX_RECEIVE_COUNT inválido (inteiro >= 1): ${MAX_RECEIVE_COUNT}" >&2
  exit 1
fi

# Aplica RedrivePolicy nas filas principais (idempotente em fila já existente).
# create-queue não atualiza atributos de fila pré-existente — por isso set-queue-attributes.
apply_main_redrive() {
  local queue_url="$1"
  local dlq_arn="$2"
  awslocal sqs set-queue-attributes \
    --queue-url "${queue_url}" \
    --attributes "{
      \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}\"
    }"
}

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
  --attributes VisibilityTimeout=30 \
  --query 'QueueUrl' --output text)

apply_main_redrive "$EVENTS_URL" "$EVENTS_DLQ_ARN"

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
    \"VisibilityTimeout\": \"30\"
  }" \
  --query 'QueueUrl' --output text)

apply_main_redrive "$INBOUND_URL" "$INBOUND_DLQ_ARN"

echo "SQS EVENTS:  $EVENTS_URL"
echo "SQS EVENTS DLQ: $EVENTS_DLQ_URL"
echo "SQS INBOUND FIFO: $INBOUND_URL"
echo "SQS INBOUND DLQ:  $INBOUND_DLQ_URL"
echo "Region:   $REGION"
echo "SQS_MAX_RECEIVE_COUNT (redrive): $MAX_RECEIVE_COUNT"
