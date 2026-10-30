#!/usr/bin/env bash
set -euo pipefail

echo "Waiting for LocalStack SQS..."
until awslocal sqs list-queues >/dev/null 2>&1; do
  sleep 1
done

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name jungle-wager-events-dlq \
  --attributes VisibilityTimeout=30 \
  --query 'QueueUrl' --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

# Decisões de implementação: VisibilityTimeout=30, maxReceiveCount=5
MAIN_URL=$(awslocal sqs create-queue \
  --queue-name jungle-wager-events \
  --attributes "{
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" \
  --query 'QueueUrl' --output text)

echo "SQS DLQ:  $DLQ_URL"
echo "SQS MAIN: $MAIN_URL"
echo "Region:   $REGION"
