// Detection rules: what each provider, data store, vendor and control looks
// like in code and manifests. `deps` match package names (npm or PyPI);
// `code` patterns match a single source line.

// Matches an import or require of one of the given modules (JS or Python).
// Bare vendor names are too common in UI strings and docs to count.
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export function imp(...mods) {
  const js = mods.map(esc).join('|');
  const py = mods.filter((m) => /^[a-z_][a-z0-9_.]*$/.test(m)).map(esc).join('|');
  return new RegExp(`(?:from\\s+['"]|require\\(\\s*['"]|import\\(\\s*['"]|import\\s+['"])(?:${js})(?:['"/])${py ? `|^\\s*(?:import|from)\\s+(?:${py})\\b` : ''}`);
}

export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic (Claude API)', deps: ['@anthropic-ai/sdk', 'anthropic', '@ai-sdk/anthropic', '@langchain/anthropic', 'langchain-anthropic', 'llama-index-llms-anthropic', '@anthropic-ai/claude-agent-sdk', 'claude-agent-sdk'],
    code: [/from\s+['"]@anthropic-ai\/(sdk|claude-agent-sdk)/, /require\(['"]@anthropic-ai\/sdk/, /^\s*(import anthropic|from anthropic import)/, /new Anthropic\(/, /anthropic\.Anthropic\(/, /@ai-sdk\/anthropic/, /ChatAnthropic/, /claude_agent_sdk/],
    hosts: ['api.anthropic.com'], env: /^ANTHROPIC_/ },
  { id: 'openai', name: 'OpenAI API', deps: ['openai', '@ai-sdk/openai', '@langchain/openai', 'langchain-openai', 'llama-index-llms-openai', '@openai/agents', 'openai-agents'],
    code: [/from\s+['"]openai['"]/, /require\(['"]openai['"]\)/, /^\s*(import openai|from openai import (?!AzureOpenAI))/, /new OpenAI\(/, /openai\.OpenAI\(/, /@ai-sdk\/openai/, /ChatOpenAI|OpenAIEmbeddings/, /from agents import/],
    hosts: ['api.openai.com'], env: /^OPENAI_/ },
  { id: 'azure-openai', name: 'Azure OpenAI', deps: ['@azure/openai', '@ai-sdk/azure', 'azure-ai-inference', '@azure-rest/ai-inference', 'azure-ai-openai'],
    code: [/AzureOpenAI|AzureChatOpenAI|AzureOpenAIEmbeddings/, /openai\.azure\.com/, /@ai-sdk\/azure/, /createAzure\(/],
    hosts: ['*.openai.azure.com'], env: /^AZURE_OPENAI_/ },
  { id: 'bedrock', name: 'AWS Bedrock', deps: ['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock', '@aws-sdk/client-bedrock-agent-runtime', '@ai-sdk/amazon-bedrock', '@langchain/aws', 'langchain-aws', 'llama-index-llms-bedrock'],
    code: [/client-bedrock/, /BedrockRuntimeClient|InvokeModelCommand|ConverseCommand|ConverseStreamCommand/, /client\(\s*['"]bedrock(-runtime|-agent-runtime)?['"]/, /ChatBedrock|BedrockEmbeddings|BedrockLLM/, /AnthropicBedrock/, /@ai-sdk\/amazon-bedrock/, /invoke_model|converse\(/],
    hosts: ['bedrock-runtime.<region>.amazonaws.com'], env: /^(AWS_BEDROCK|BEDROCK)_/ },
  { id: 'vertex', name: 'Google Vertex AI', deps: ['@google-cloud/vertexai', 'google-cloud-aiplatform', 'vertexai', '@ai-sdk/google-vertex', '@langchain/google-vertexai', 'langchain-google-vertexai', '@anthropic-ai/vertex-sdk'],
    code: [/@google-cloud\/vertexai|google\.cloud\.aiplatform|from vertexai|import vertexai/, /AnthropicVertex/, /@ai-sdk\/google-vertex/, /ChatVertexAI|VertexAIEmbeddings/, /aiplatform\.googleapis\.com/, /vertexai\s*=\s*True|vertexai:\s*true/],
    hosts: ['<region>-aiplatform.googleapis.com'], env: /^(VERTEX_|GOOGLE_CLOUD_PROJECT)/ },
  { id: 'gemini', name: 'Google Gemini API (AI Studio)', deps: ['@google/generative-ai', '@google/genai', 'google-generativeai', 'google-genai', '@ai-sdk/google', '@langchain/google-genai', 'langchain-google-genai'],
    code: [/@google\/(generative-ai|genai)/, /google\.generativeai|from google import genai|google\.genai/, /GoogleGenerativeAI|GoogleGenAI|ChatGoogleGenerativeAI/, /@ai-sdk\/google['"]/, /generativelanguage\.googleapis\.com/],
    hosts: ['generativelanguage.googleapis.com'], env: /^(GEMINI_|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI)/ },
  { id: 'mistral', name: 'Mistral AI', deps: ['@mistralai/mistralai', 'mistralai', '@ai-sdk/mistral', '@langchain/mistralai', 'langchain-mistralai'], code: [imp('@mistralai/mistralai', 'mistralai'), /MistralClient|new Mistral\(/], hosts: ['api.mistral.ai'], env: /^MISTRAL_/ },
  { id: 'cohere', name: 'Cohere', deps: ['cohere-ai', 'cohere', '@ai-sdk/cohere', '@langchain/cohere', 'langchain-cohere'], code: [imp('cohere-ai', 'cohere'), /CohereClient(V2)?\(|cohere\.Client(V2)?\(/], hosts: ['api.cohere.com'], env: /^(COHERE|CO)_API_KEY/ },
  { id: 'groq', name: 'Groq', deps: ['groq-sdk', 'groq', '@ai-sdk/groq', 'langchain-groq'], code: [imp('groq-sdk', 'groq'), /new Groq\(/], hosts: ['api.groq.com'], env: /^GROQ_/ },
  { id: 'together', name: 'Together AI', deps: ['together-ai', 'together', '@ai-sdk/togetherai'], code: [imp('together-ai', 'together')], hosts: ['api.together.xyz'], env: /^TOGETHER_/ },
  { id: 'fireworks', name: 'Fireworks AI', deps: ['@ai-sdk/fireworks', 'fireworks-ai'], code: [imp('fireworks-ai', 'fireworks')], hosts: ['api.fireworks.ai'], env: /^FIREWORKS_/ },
  { id: 'deepseek', name: 'DeepSeek', deps: ['@ai-sdk/deepseek'], code: [], hosts: ['api.deepseek.com'], env: /^DEEPSEEK_/ },
  { id: 'xai', name: 'xAI (Grok)', deps: ['@ai-sdk/xai', 'xai-sdk'], code: [], hosts: ['api.x.ai'], env: /^XAI_/ },
  { id: 'perplexity', name: 'Perplexity', deps: ['@ai-sdk/perplexity'], code: [], hosts: ['api.perplexity.ai'], env: /^PERPLEXITY_/ },
  { id: 'huggingface', name: 'Hugging Face Inference', deps: ['@huggingface/inference', 'huggingface_hub', 'huggingface-hub'], code: [imp('@huggingface/inference', 'huggingface_hub'), /router\.huggingface\.co/], hosts: ['api-inference.huggingface.co'], env: /^(HF_|HUGGINGFACE)/ },
  { id: 'replicate', name: 'Replicate', deps: ['replicate'], code: [imp('replicate'), /new Replicate\(/], hosts: ['api.replicate.com'], env: /^REPLICATE_/ },
  { id: 'voyage', name: 'Voyage AI (embeddings)', deps: ['voyageai', 'voyage-ai-provider'], code: [imp('voyageai', 'voyage-ai-provider')], hosts: ['api.voyageai.com'], env: /^VOYAGE_/ },
  { id: 'openrouter', name: 'OpenRouter', deps: ['@openrouter/ai-sdk-provider'], code: [imp('@openrouter/ai-sdk-provider')], hosts: ['openrouter.ai'], env: /^OPENROUTER_/ },
  { id: 'litellm', name: 'LiteLLM (proxy/router; check which providers it routes to)', deps: ['litellm'], code: [/^\s*(import litellm|from litellm)/], hosts: [], env: /^LITELLM_/ },
  { id: 'ollama', name: 'Ollama (local model)', local: true, deps: ['ollama', 'ollama-ai-provider', '@langchain/ollama', 'langchain-ollama'], code: [imp('ollama', 'ollama-ai-provider', '@langchain/ollama', 'langchain_ollama'), /localhost:11434|127\.0\.0\.1:11434|ChatOllama|OllamaEmbeddings/], hosts: ['localhost:11434'], env: /^OLLAMA_/ },
  { id: 'local-models', name: 'Local / self-hosted models (transformers, vLLM, llama.cpp)', local: true, deps: ['transformers', 'sentence-transformers', 'vllm', 'llama-cpp-python', 'node-llama-cpp', '@xenova/transformers', '@huggingface/transformers', 'ctransformers', 'gpt4all', 'mlx-lm'],
    code: [/from transformers import|AutoModel|AutoTokenizer|pipeline\(\s*["'](text-generation|feature-extraction|summarization)/, /SentenceTransformer\(/, /from vllm|LLM\(model=/, /llama_cpp|node-llama-cpp/, /@xenova\/transformers|@huggingface\/transformers/], hosts: [], env: /^$/ },
  { id: 'ai-sdk', name: 'Vercel AI SDK (wrapper; provider is set separately)', wrapper: true, deps: ['ai'], code: [/from\s+['"]ai['"]/], hosts: [], env: /^$/ },
  { id: 'langchain', name: 'LangChain / LangGraph (wrapper)', wrapper: true, deps: ['langchain', '@langchain/core', '@langchain/langgraph', 'langgraph', 'langchain-core', 'langchain-community'], code: [/from langchain|@langchain\/|from langgraph/], hosts: [], env: /^$/ },
  { id: 'llamaindex', name: 'LlamaIndex (wrapper)', wrapper: true, deps: ['llamaindex', 'llama-index', 'llama-index-core'], code: [/from llama_index|from ['"]llamaindex['"]/], hosts: [], env: /^$/ },
];

// Model IDs only count when they appear as a quoted string.
export const MODEL_ID = new RegExp('["\'`]((?:us\\.|eu\\.|apac\\.|global\\.)?(?:anthropic\\.)?claude-[a-z0-9][a-z0-9.\\-:@]*' +
  '|gpt-[0-9][a-z0-9.\\-]*|gpt-oss-[0-9a-z\\-]+|o[1-9](?:-mini|-pro|-preview)?(?:-[0-9]{4}-[0-9]{2}-[0-9]{2})?|chatgpt-[a-z0-9.\\-]+' +
  '|text-embedding-[a-z0-9\\-]+|gemini-[0-9][a-z0-9.\\-]*|gemini-embedding-[a-z0-9.\\-]+|textembedding-gecko[@a-z0-9\\-]*' +
  '|amazon\\.(?:titan|nova)[a-z0-9.\\-:]*|cohere\\.[a-z0-9.\\-:]+|meta\\.llama[a-z0-9.\\-:]+|mistral\\.[a-z0-9.\\-:]+' +
  '|(?:open-)?mistral-[a-z0-9.\\-]+|codestral-[a-z0-9\\-]+|command-(?:r|a|light|nightly|xlarge|medium)(?:-[a-z0-9.\\-]+)?|embed-(?:english|multilingual)-[a-z0-9.\\-]+' +
  '|(?:meta-llama\\/)?llama-?[0-9][a-z0-9.\\-:]*|qwen[0-9.]*[a-z0-9.\\-:]*|deepseek-[a-z0-9.\\-]+|grok-[a-z0-9.\\-]+' +
  '|(?:sentence-transformers\\/)?all-(?:MiniLM|mpnet)[A-Za-z0-9\\-]*|BAAI\\/bge-[a-z0-9.\\-]+|nomic-embed-text[a-z0-9.\\-:]*' +
  '|voyage-[a-z0-9.\\-]+|whisper-[0-9a-z\\-]+|dall-e-[0-9]|gpt-image-[0-9a-z\\-]+|tts-1(?:-hd)?)["\'`]', 'g');

export const DATASTORES = [
  { id: 'pinecone', name: 'Pinecone', category: 'vector', deps: ['@pinecone-database/pinecone', 'pinecone-client', 'pinecone', '@langchain/pinecone', 'langchain-pinecone'], code: [imp('@pinecone-database/pinecone', 'pinecone', '@langchain/pinecone', 'langchain_pinecone'), /new Pinecone\(|PineconeStore/], vendor: true },
  { id: 'weaviate', name: 'Weaviate', category: 'vector', deps: ['weaviate-client', 'weaviate-ts-client'], code: [imp('weaviate-client', 'weaviate-ts-client', 'weaviate'), /weaviate\.(connect_to|client)/], vendor: true },
  { id: 'qdrant', name: 'Qdrant', category: 'vector', deps: ['@qdrant/js-client-rest', 'qdrant-client', '@langchain/qdrant', 'langchain-qdrant'], code: [imp('@qdrant/js-client-rest', 'qdrant_client', '@langchain/qdrant', 'langchain_qdrant'), /QdrantClient|QdrantVectorStore/], vendor: true },
  { id: 'chroma', name: 'Chroma', category: 'vector', deps: ['chromadb', 'langchain-chroma'], code: [/chromadb|ChromaClient|Chroma\(/], vendor: false },
  { id: 'milvus', name: 'Milvus / Zilliz', category: 'vector', deps: ['@zilliz/milvus2-sdk-node', 'pymilvus'], code: [imp('@zilliz/milvus2-sdk-node', 'pymilvus'), /MilvusClient/], vendor: true },
  { id: 'lancedb', name: 'LanceDB', category: 'vector', deps: ['@lancedb/lancedb', 'vectordb', 'lancedb'], code: [imp('@lancedb/lancedb', 'vectordb', 'lancedb')], vendor: false },
  { id: 'faiss', name: 'FAISS (in-process)', category: 'vector', deps: ['faiss-cpu', 'faiss-gpu', 'faiss-node'], code: [/\bfaiss\b|FAISS\./], vendor: false },
  { id: 'pgvector', name: 'Postgres + pgvector', category: 'vector', deps: ['pgvector', '@langchain/pgvector', 'langchain-postgres'], code: [/pgvector|vector\(\d+\)|<=>|PGVector|CREATE EXTENSION (IF NOT EXISTS )?vector/i], vendor: false },
  { id: 'turbopuffer', name: 'turbopuffer', category: 'vector', deps: ['@turbopuffer/turbopuffer', 'turbopuffer'], code: [imp('@turbopuffer/turbopuffer', 'turbopuffer')], vendor: true },
  { id: 'upstash-vector', name: 'Upstash Vector', category: 'vector', deps: ['@upstash/vector', 'upstash-vector'], code: [/@upstash\/vector|upstash_vector/], vendor: true },
  { id: 'mongodb-atlas-vector', name: 'MongoDB Atlas Vector Search', category: 'vector', deps: ['@langchain/mongodb', 'langchain-mongodb'], code: [/\$vectorSearch|MongoDBAtlasVectorSearch/], vendor: true },
  { id: 'opensearch', name: 'OpenSearch / Elasticsearch', category: 'search', deps: ['@opensearch-project/opensearch', 'opensearch-py', '@elastic/elasticsearch', 'elasticsearch'], code: [imp('@opensearch-project/opensearch', 'opensearchpy', '@elastic/elasticsearch', 'elasticsearch'), /OpenSearchVectorSearch|ElasticsearchStore/], vendor: false },
  { id: 'azure-ai-search', name: 'Azure AI Search', category: 'vector', deps: ['@azure/search-documents', 'azure-search-documents'], code: [/search\.windows\.net|SearchClient\(/], vendor: true },
  { id: 'vertex-vector-search', name: 'Vertex AI Vector Search', category: 'vector', deps: [], code: [/MatchingEngineIndex|VectorSearchVectorStore/], vendor: true },
  { id: 'bedrock-kb', name: 'Bedrock Knowledge Bases', category: 'vector', deps: ['@aws-sdk/client-bedrock-agent-runtime'], code: [/RetrieveCommand|RetrieveAndGenerate|retrieve_and_generate|knowledgeBaseId|knowledge_base_id/], vendor: false },
  { id: 'postgres', name: 'PostgreSQL', category: 'database', deps: ['pg', 'postgres', '@neondatabase/serverless', '@vercel/postgres', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg', '@prisma/client', 'drizzle-orm', 'sqlalchemy', 'kysely', 'typeorm', 'sequelize'], code: [/postgres(ql)?:\/\/|from ['"]pg['"]|new Pool\(|psycopg|asyncpg|provider\s*=\s*"postgresql"/], vendor: false },
  { id: 'mysql', name: 'MySQL', category: 'database', deps: ['mysql2', 'mysql', 'pymysql', 'mysqlclient'], code: [/mysql:\/\/|provider\s*=\s*"mysql"/], vendor: false },
  { id: 'sqlite', name: 'SQLite', category: 'database', deps: ['better-sqlite3', 'sqlite3', 'libsql', '@libsql/client'], code: [/sqlite3|better-sqlite3|\.sqlite\b|provider\s*=\s*"sqlite"/], vendor: false },
  { id: 'mongodb', name: 'MongoDB', category: 'database', deps: ['mongodb', 'mongoose', 'pymongo', 'motor'], code: [/mongodb(\+srv)?:\/\/|MongoClient|mongoose\./], vendor: false },
  { id: 'dynamodb', name: 'DynamoDB', category: 'database', deps: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'], code: [imp('@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'), /DynamoDBClient|boto3\.(client|resource)\(\s*['"]dynamodb/], vendor: false },
  { id: 'firestore', name: 'Firestore', category: 'database', deps: ['google-cloud-firestore', '@google-cloud/firestore'], code: [imp('firebase/firestore', 'firebase-admin/firestore', '@google-cloud/firestore', 'google.cloud.firestore'), /getFirestore\(|admin\.firestore\(\)/], vendor: true },
  { id: 'supabase', name: 'Supabase', category: 'database', deps: ['@supabase/supabase-js', 'supabase'], code: [imp('@supabase/supabase-js', '@supabase/ssr', 'supabase'), /\.supabase\.co\b/], vendor: true },
  { id: 'redis', name: 'Redis / Valkey', category: 'cache', deps: ['redis', 'ioredis', '@upstash/redis', '@vercel/kv'], code: [/rediss?:\/\/|new Redis\(|createClient\(|@upstash\/redis|Redis\.from_url/], vendor: false },
  { id: 'neo4j', name: 'Neo4j', category: 'database', deps: ['neo4j-driver', 'neo4j'], code: [imp('neo4j-driver', 'neo4j'), /neo4j(\+s)?:\/\//], vendor: false },
  { id: 's3', name: 'Amazon S3', category: 'object-storage', deps: ['@aws-sdk/client-s3', '@aws-sdk/lib-storage'], code: [/S3Client|PutObjectCommand|GetObjectCommand|client\(\s*['"]s3['"]|upload_file|put_object/], vendor: false },
  { id: 'gcs', name: 'Google Cloud Storage', category: 'object-storage', deps: ['@google-cloud/storage', 'google-cloud-storage'], code: [/@google-cloud\/storage|from google\.cloud import storage/], vendor: false },
  { id: 'azure-blob', name: 'Azure Blob Storage', category: 'object-storage', deps: ['@azure/storage-blob', 'azure-storage-blob'], code: [/BlobServiceClient/], vendor: false },
];

export const VENDORS = [
  // telemetry / LLM observability: these often receive full prompts and outputs
  { id: 'langfuse', name: 'Langfuse', category: 'llm-observability', deps: ['langfuse', 'langfuse-langchain', '@langfuse/tracing', '@langfuse/otel'], code: [imp('langfuse', '@langfuse/tracing', '@langfuse/otel', 'langfuse-langchain'), /new Langfuse\(/], receivesPrompts: true },
  { id: 'langsmith', name: 'LangSmith', category: 'llm-observability', deps: ['langsmith'], code: [imp('langsmith'), /LANGCHAIN_TRACING|LANGSMITH_TRACING/], receivesPrompts: true },
  { id: 'helicone', name: 'Helicone', category: 'llm-observability', deps: ['@helicone/helicone'], code: [imp('@helicone/helicone'), /helicone\.ai/], receivesPrompts: true },
  { id: 'braintrust', name: 'Braintrust', category: 'llm-observability', deps: ['braintrust'], code: [imp('braintrust'), /api\.braintrust\.dev/], receivesPrompts: true },
  { id: 'arize', name: 'Arize / Phoenix', category: 'llm-observability', deps: ['arize-phoenix', 'arize', '@arizeai/openinference-instrumentation-openai'], code: [imp('arize', 'phoenix', '@arizeai/openinference-instrumentation-openai'), /phoenix\.otel|openinference/], receivesPrompts: true },
  { id: 'wandb', name: 'Weights & Biases (Weave)', category: 'llm-observability', deps: ['wandb', 'weave'], code: [/^\s*import (wandb|weave)/], receivesPrompts: true },
  { id: 'sentry', name: 'Sentry', category: 'error-monitoring', deps: ['@sentry/nextjs', '@sentry/node', '@sentry/react', 'sentry-sdk'], code: [/Sentry\.init|sentry_sdk\.init/] },
  { id: 'datadog', name: 'Datadog', category: 'apm', deps: ['dd-trace', 'ddtrace', '@datadog/browser-rum', 'datadog'], code: [/dd-trace|ddtrace|datadoghq/] },
  { id: 'newrelic', name: 'New Relic', category: 'apm', deps: ['newrelic'], code: [imp('newrelic')] },
  { id: 'opentelemetry', name: 'OpenTelemetry (check the exporter destination)', category: 'tracing', deps: ['@opentelemetry/api', '@opentelemetry/sdk-node', '@vercel/otel', 'opentelemetry-sdk', 'opentelemetry-api'], code: [/@opentelemetry|registerOTel|from opentelemetry/] },
  { id: 'posthog', name: 'PostHog', category: 'product-analytics', deps: ['posthog-js', 'posthog-node', 'posthog'], code: [imp('posthog-js', 'posthog-node', 'posthog'), /posthog\.(init|capture)\(|new PostHog\(/] },
  { id: 'segment', name: 'Segment', category: 'product-analytics', deps: ['@segment/analytics-next', '@segment/analytics-node', 'analytics-python'], code: [/segment\.(com|io)|AnalyticsBrowser/] },
  { id: 'mixpanel', name: 'Mixpanel', category: 'product-analytics', deps: ['mixpanel', 'mixpanel-browser'], code: [imp('mixpanel', 'mixpanel-browser'), /mixpanel\.(init|track)\(/] },
  { id: 'amplitude', name: 'Amplitude', category: 'product-analytics', deps: ['@amplitude/analytics-browser', '@amplitude/analytics-node'], code: [/@amplitude\//] },
  { id: 'logrocket', name: 'LogRocket / session replay', category: 'session-replay', deps: ['logrocket', '@fullstory/browser', '@highlight-run/next'], code: [imp('logrocket', '@fullstory/browser', '@highlight-run/next'), /LogRocket\.init\(/] },
  { id: 'vercel-analytics', name: 'Vercel Analytics', category: 'product-analytics', deps: ['@vercel/analytics', '@vercel/speed-insights'], code: [/@vercel\/analytics/] },
  // auth
  { id: 'nextauth', name: 'Auth.js / NextAuth', category: 'auth', deps: ['next-auth', '@auth/core'], code: [/next-auth|NextAuth\(/] },
  { id: 'clerk', name: 'Clerk', category: 'auth', deps: ['@clerk/nextjs', '@clerk/clerk-sdk-node', '@clerk/express', 'clerk-backend-api'], code: [/@clerk\//] },
  { id: 'auth0', name: 'Auth0', category: 'auth', deps: ['@auth0/nextjs-auth0', 'auth0', 'express-openid-connect'], code: [imp('@auth0/nextjs-auth0', 'auth0', 'express-openid-connect'), /\.auth0\.com/] },
  { id: 'cognito', name: 'Amazon Cognito', category: 'auth', deps: ['amazon-cognito-identity-js', '@aws-sdk/client-cognito-identity-provider', 'aws-jwt-verify'], code: [imp('amazon-cognito-identity-js', '@aws-sdk/client-cognito-identity-provider', 'aws-jwt-verify'), /CognitoJwtVerifier|cognito-idp\./] },
  { id: 'firebase-auth', name: 'Firebase Auth', category: 'auth', deps: ['firebase', 'firebase-admin'], code: [imp('firebase/auth', 'firebase-admin', 'firebase-admin/auth', 'firebase_admin'), /verifyIdToken\(/] },
  { id: 'okta', name: 'Okta', category: 'auth', deps: ['@okta/okta-auth-js', '@okta/jwt-verifier'], code: [imp('@okta/okta-auth-js', '@okta/jwt-verifier', 'next-auth/providers/okta'), /\.okta\.com|\bOkta\(/] },
  { id: 'workos', name: 'WorkOS', category: 'auth', deps: ['@workos-inc/node', '@workos-inc/authkit-nextjs', 'workos'], code: [imp('@workos-inc/node', '@workos-inc/authkit-nextjs', 'workos')] },
  { id: 'better-auth', name: 'Better Auth (library)', category: 'auth', deps: ['better-auth'], code: [imp('better-auth')] },
  { id: 'supabase-auth', name: 'Supabase Auth', category: 'auth', deps: [], code: [/supabase\.auth\.(getUser|getSession|signIn)/] },
  { id: 'entra', name: 'Microsoft Entra ID (MSAL)', category: 'auth', deps: ['@azure/msal-node', '@azure/msal-browser', 'msal'], code: [imp('@azure/msal-node', '@azure/msal-browser', 'msal')] },
  // email / messaging
  { id: 'ses', name: 'Amazon SES', category: 'email', deps: ['@aws-sdk/client-ses', '@aws-sdk/client-sesv2'], code: [/SendEmailCommand|client\(\s*['"]ses['"]|SESClient|SESv2Client/] },
  { id: 'sendgrid', name: 'SendGrid', category: 'email', deps: ['@sendgrid/mail', 'sendgrid'], code: [imp('@sendgrid/mail', 'sendgrid'), /api\.sendgrid\.com/] },
  { id: 'resend', name: 'Resend', category: 'email', deps: ['resend'], code: [/new Resend\(|resend\.emails/] },
  { id: 'postmark', name: 'Postmark', category: 'email', deps: ['postmark', 'postmarker'], code: [imp('postmark', 'postmarker'), /api\.postmarkapp\.com/] },
  { id: 'twilio', name: 'Twilio', category: 'messaging', deps: ['twilio'], code: [imp('twilio'), /api\.twilio\.com/] },
  { id: 'slack', name: 'Slack API', category: 'messaging', deps: ['@slack/web-api', '@slack/bolt', 'slack-sdk', 'slack_sdk'], code: [/@slack\/|slack_sdk|hooks\.slack\.com/] },
  // payments
  { id: 'stripe', name: 'Stripe', category: 'payments', deps: ['stripe'], code: [imp('stripe'), /new Stripe\(|api\.stripe\.com/] },
  // web search / scraping / parsing: these receive queries derived from user input
  { id: 'tavily', name: 'Tavily search', category: 'web-search', deps: ['@tavily/core', 'tavily-python'], code: [imp('@tavily/core', 'tavily'), /api\.tavily\.com/], receivesPrompts: true },
  { id: 'serpapi', name: 'SerpAPI', category: 'web-search', deps: ['serpapi', 'google-search-results'], code: [imp('serpapi', 'google-search-results'), /serpapi\.com/], receivesPrompts: true },
  { id: 'exa', name: 'Exa search', category: 'web-search', deps: ['exa-js', 'exa-py'], code: [/exa-js|exa_py|api\.exa\.ai/], receivesPrompts: true },
  { id: 'brave-search', name: 'Brave Search API', category: 'web-search', deps: [], code: [/api\.search\.brave\.com/], receivesPrompts: true },
  { id: 'firecrawl', name: 'Firecrawl', category: 'scraping', deps: ['@mendable/firecrawl-js', 'firecrawl-py'], code: [imp('@mendable/firecrawl-js', 'firecrawl'), /api\.firecrawl\.dev/] },
  { id: 'browserbase', name: 'Browserbase', category: 'browser', deps: ['@browserbasehq/sdk', '@browserbasehq/stagehand', 'browserbase'], code: [imp('@browserbasehq/sdk', '@browserbasehq/stagehand', 'browserbase')] },
  { id: 'unstructured', name: 'Unstructured (document parsing)', category: 'doc-parsing', deps: ['unstructured', 'unstructured-client'], code: [imp('unstructured', 'unstructured-client', 'unstructured_client'), /api\.unstructured(app)?\.io/], receivesPrompts: true },
  { id: 'llamaparse', name: 'LlamaParse', category: 'doc-parsing', deps: ['llama-parse', 'llama-cloud-services'], code: [/LlamaParse/], receivesPrompts: true },
  { id: 'textract', name: 'Amazon Textract', category: 'doc-parsing', deps: ['@aws-sdk/client-textract'], code: [/Textract/], receivesPrompts: true },
  { id: 'uploadthing', name: 'UploadThing', category: 'file-storage', deps: ['uploadthing'], code: [imp('uploadthing')] },
  { id: 'cloudinary', name: 'Cloudinary', category: 'file-storage', deps: ['cloudinary'], code: [imp('cloudinary')] },
];

export const SECRET_MANAGERS = [
  { id: 'aws-secrets-manager', name: 'AWS Secrets Manager', deps: ['@aws-sdk/client-secrets-manager'], code: [/SecretsManagerClient|GetSecretValueCommand|client\(\s*['"]secretsmanager['"]|get_secret_value/] },
  { id: 'aws-ssm', name: 'AWS SSM Parameter Store', deps: ['@aws-sdk/client-ssm'], code: [/SSMClient|GetParameterCommand|client\(\s*['"]ssm['"]|get_parameter\(/] },
  { id: 'vault', name: 'HashiCorp Vault', deps: ['node-vault', 'hvac'], code: [/node-vault|hvac\.Client/] },
  { id: 'gcp-secret-manager', name: 'Google Secret Manager', deps: ['@google-cloud/secret-manager', 'google-cloud-secret-manager'], code: [/SecretManagerServiceClient/] },
  { id: 'azure-key-vault', name: 'Azure Key Vault', deps: ['@azure/keyvault-secrets', 'azure-keyvault-secrets'], code: [/SecretClient\(|vault\.azure\.net/] },
  { id: 'doppler', name: 'Doppler', deps: ['@dopplerhq/node-sdk'], code: [/doppler run|DOPPLER_TOKEN/] },
  { id: 'infisical', name: 'Infisical', deps: ['@infisical/sdk', 'infisical-python'], code: [imp('@infisical/sdk', 'infisical_client')] },
  { id: '1password', name: '1Password', deps: ['@1password/sdk', 'onepassword-sdk'], code: [/op:\/\/|@1password\//] },
  { id: 'amplify-secret', name: 'Amplify Gen 2 secret()', deps: [], code: [/\bsecret\(\s*['"][A-Z0-9_]+['"]\s*\)/] },
  { id: 'dotenv', name: 'dotenv files (local config, not a secrets store)', deps: ['dotenv', 'python-dotenv', '@dotenvx/dotenvx'], code: [/require\(['"]dotenv|from ['"]dotenv|load_dotenv\(/] },
];

// Signals that a control exists. They are hints for Claude to read, not
// proof the control works.
export const CONTROLS = {
  rateLimit: [/@upstash\/ratelimit|express-rate-limit|rate-limiter-flexible|slowapi|\bRatelimit\b|rateLimit\(|rate_limit|ratelimit\.limit|limiter\.(check|consume|limit)/],
  inputValidation: [/\bz\.(object|string)\(|\.safeParse\(|from ['"]zod['"]|BaseModel\)|Field\(.*max_length|joi\.|yup\.|valibot|\.max\(\d+/],
  moderation: [/moderations\.create|omni-moderation|text-moderation|guardrailIdentifier|guardrailConfig|guardrail_identifier|ApplyGuardrail|contentsafety|ContentSafetyClient|llama-?guard|LlamaGuard/i],
  guardrailLibrary: [/guardrails-ai|from guardrails|nemoguardrails|llm[_-]guard|rebuff|lakera|prompt-?guard|presidio/i],
  piiRedaction: [/presidio|redact(Pii|PII|_pii)?\(|scrub(Pii|PII)?\(|anonymi[sz]e\(|maskPii|mask_pii|\bmask:\s*/],
  humanApproval: [/needsApproval|requireApproval|requiresApproval|requires_approval|human_in_the_loop|humanInTheLoop|interrupt\(|canUseTool|awaitApproval|pendingApproval|approval_required|approvalRequired/],
  outputValidation: [/response_format|json_schema|generateObject|streamObject|with_structured_output|zodResponseFormat|output_parser|OutputParser|output_type=|outputType:|text\.format/],
  allowlist: [/allow-?list|ALLOWED_[A-Z_]+|allowed_?(hosts|domains|urls|tools|tables|commands|origins)|allowedTools|allowed_tools|safe_?list/i],
  untrustedContentMarking: [/untrusted|<(documents?|context|search_results|retrieved[_-]?\w*|tool_result)>|treat .* as data/i],
  tokenAndStepLimits: [/max_tokens|maxTokens|max_output_tokens|maxOutputTokens|max_completion_tokens|maxSteps|max_steps|max_iterations|maxIterations|max_turns|maxTurns|stopWhen|stepCountIs|recursion_limit|recursionLimit/],
  tenantIsolation: [/tenant_?[iI]d|org(anization)?_?[iI]d|workspace_?[iI]d|namespace:|filter:\s*\{|row level security|ENABLE ROW LEVEL SECURITY|auth\.uid\(\)/],
  auditLogging: [/audit[_-]?log|auditLog|writeAudit|recordAudit|AuditEvent|audit_event|aws_cloudtrail|CloudTrail/],
  structuredLogging: [/from ['"](pino|winston|bunyan)['"]|require\(['"](pino|winston|bunyan)|structlog|loguru|logging\.getLogger|getLogger\(/],
  csrfOrOrigin: [/csrf|csurf|checkOrigin|allowedOrigins|SameSite/i],
  secretScanning: [/detect-secrets|gitleaks|trufflehog/i],
  retentionSettings: [/\bstore\s*[:=]\s*(true|false|True|False)\b|retention_?days|retentionInDays|ttl\s*[:=]|expireAfterSeconds|expires_?at|purge|delete_after|zero[_ -]data[_ -]retention/i],
};

export const DATA_TERMS = {
  phi: /\b(patient|diagnos[ie]s|mrn|medical[_ ]record|icd[_-]?10|prescription|medication|hipaa|\bphi\b|health[_ ]record|clinical|treatment|lab[_ ]result|insurance[_ ]member)/i,
  financial: /\b(account[_ ]?number|routing[_ ]?number|iban|card[_ ]?number|cvv|credit[_ ]?score|loan|bank[_ ]?account|ssn|social[_ ]security|tax[_ ]?id|\bein\b|income|salary|net[_ ]worth|kyc|aml)\b/i,
  pii: /\b(email|phone[_ ]?(number)?|street[_ ]?address|date[_ ]?of[_ ]?birth|\bdob\b|first[_ ]?name|last[_ ]?name|full[_ ]?name|passport|driver'?s?[_ ]?licen[cs]e|ip[_ ]?address|national[_ ]?id)\b/i,
};

// Capabilities an agent tool body can have.
export const CAPABILITIES = {
  shell: /\b(child_process|execSync|execFile|spawn\(|spawnSync|subprocess\.|os\.system|os\.popen|shell=True|Bun\.spawn|Deno\.run|\$`)|(?<![.\w])exec\(/,
  codeEval: /\beval\(|new Function\(|\bvm\.run|exec\(compile|PythonREPL|python_repl|code_interpreter|runInNewContext/,
  fileWrite: /\b(writeFile|appendFile|createWriteStream|fs\.write|unlink|rmSync|rmdir|shutil\.(rmtree|move|copy)|os\.remove|\.write_text|\.write_bytes)\b|open\([^)]*['"][wa]b?\+?['"]/,
  fileRead: /\b(readFile|createReadStream|readdir|read_text|read_bytes|os\.listdir|glob\()|open\(/,
  network: /\b(fetch\(|axios|got\(|ky\(|requests\.(get|post|put|patch|delete|request)|httpx\.|urllib|aiohttp|http\.request|https\.request|urlopen)/,
  dbWrite: /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE)\b|\.(insert|update|delete|upsert|destroy|deleteMany|updateMany|insertMany|put_item|delete_item)\w*\(/,
  dbRead: /\bSELECT\s|\.(query|execute|find(One|Many|First|Unique)?|findMany|aggregate|search|get_item|scan)\(|similarity_search|\.from\(['"]\w+['"]\)\.select\(/,
  arbitrarySql: /\.(query|execute|raw|unsafe)\(\s*(args|input|params|sql|query|statement|cmd)\b|\$queryRawUnsafe|\$executeRawUnsafe|execute\(\s*f["']|query\(\s*`[^`]*\$\{/,
  sendMessage: /sendEmail|send_email|SendEmailCommand|sendMail|resend\.emails|sgMail|postmark|twilio|chat\.postMessage|messages\.create\(\s*\{\s*to|webhook/i,
  payments: /\bstripe\.|paymentIntents|charges\.create|refunds\.create|payouts|transfers\.create/,
  cloudApi: /@aws-sdk\/client-(?!bedrock)|boto3\.client|googleapis|@google-cloud\/|@azure\/(?!openai)/,
  browser: /puppeteer|playwright|chromium\.launch|page\.goto/,
};
