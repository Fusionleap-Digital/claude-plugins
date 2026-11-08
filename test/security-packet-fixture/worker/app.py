"""Document worker: extracts text from uploaded claim documents, summarizes
them with Claude on Bedrock, and hands the text to the Next.js ingest route."""
import io
import json
import logging

import boto3
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile
from pypdf import PdfReader

from settings import AWS_REGION, INGEST_URL, INTERNAL_SERVICE_TOKEN, WORKER_API_KEY

log = logging.getLogger("worker")
app = FastAPI()
bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)

SUMMARY_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def verify_api_key(x_api_key: str = Header(...)):
    if x_api_key != WORKER_API_KEY:
        raise HTTPException(status_code=403)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/documents")
async def upload_document(tenant_id: str, file: UploadFile, _: None = Depends(verify_api_key)):
    data = await file.read()
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages)
    summary = summarize(text)
    log.info("summarized document %s: %s", file.filename, summary)
    httpx.post(INGEST_URL, json={"tenantId": tenant_id, "title": file.filename, "text": text},
               headers={"authorization": f"Bearer {INTERNAL_SERVICE_TOKEN}"}, timeout=30)
    return {"summary": summary}


@app.post("/summarize")
async def summarize_text(body: dict):
    return {"summary": summarize(body["text"])}


def summarize(text: str) -> str:
    resp = bedrock.converse(
        modelId=SUMMARY_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": f"Summarize this claim document:\n\n{text[:50000]}"}]}],
        inferenceConfig={"maxTokens": 800},
    )
    return resp["output"]["message"]["content"][0]["text"]
