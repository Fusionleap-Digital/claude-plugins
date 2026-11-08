terraform {
  required_version = ">= 1.6"
  backend "s3" {
    bucket  = "claims-copilot-tfstate"
    key     = "prod/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}

provider "aws" {
  region = var.region
}

resource "aws_kms_key" "data" {
  description         = "claims-copilot data key"
  enable_key_rotation = true
}

# Policy documents and claim files uploaded by adjusters.
resource "aws_s3_bucket" "docs" {
  bucket = "claims-copilot-docs-${var.env}"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Raw exports for the analytics team. No encryption or public access block set.
resource "aws_s3_bucket" "exports" {
  bucket = "claims-copilot-exports-${var.env}"
}

# Postgres with pgvector: claims, chat history, policy chunks and embeddings.
resource "aws_db_instance" "main" {
  identifier              = "claims-copilot-${var.env}"
  engine                  = "postgres"
  engine_version          = "16.4"
  instance_class          = "db.t4g.medium"
  allocated_storage       = 100
  storage_encrypted       = true
  kms_key_id              = aws_kms_key.data.arn
  publicly_accessible     = false
  backup_retention_period = 14
  deletion_protection     = true
  username                = "claims_admin"
  password                = var.db_password
  vpc_security_group_ids  = [aws_security_group.db.id]
}

resource "aws_security_group" "db" {
  name = "claims-copilot-db"
  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/claims-copilot/worker"
  retention_in_days = 30
}

resource "aws_lambda_function" "worker" {
  function_name = "claims-copilot-worker"
  role          = aws_iam_role.worker.arn
  runtime       = "python3.12"
  handler       = "app.handler"
  filename      = "worker.zip"
  timeout       = 60
  memory_size   = 1024
}

resource "aws_lambda_function_url" "worker" {
  function_name      = aws_lambda_function.worker.function_name
  authorization_type = "NONE"
}

resource "aws_iam_role" "worker" {
  name               = "claims-copilot-worker"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }] })
}

resource "aws_iam_role_policy" "worker_bedrock" {
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = "*"
    }]
  })
}

resource "aws_secretsmanager_secret" "app" {
  name       = "claims-copilot/${var.env}/app"
  kms_key_id = aws_kms_key.data.arn
}
