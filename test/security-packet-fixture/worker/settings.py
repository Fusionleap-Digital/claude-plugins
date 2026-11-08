import os

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
INGEST_URL = os.environ.get("INGEST_URL", "https://claims-copilot.internal.example-insurer.test/api/ingest")
WORKER_API_KEY = os.environ["WORKER_API_KEY"]

# TODO: move to Secrets Manager before go-live
INTERNAL_SERVICE_TOKEN = "wk_7f3a9c2e1b8d4f60a2c5"
