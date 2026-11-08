// Infrastructure as code: Terraform, CloudFormation / SAM, CDK, Amplify and
// docker-compose. Regions, encryption settings and public exposure.
import { ref, isComment, lineOf } from './files.mjs';

// Resource types where at-rest encryption is a setting worth reporting.
// `key` lists attributes (or companion resources) that declare it; `def`
// says what the provider does when nothing is declared.
const ENCRYPTABLE = {
  aws_s3_bucket: { key: ['server_side_encryption_configuration', 'aws_s3_bucket_server_side_encryption_configuration'], def: 'AWS applies SSE-S3 (AES-256) to new objects by default since Jan 2023; no customer-managed key' },
  aws_db_instance: { key: ['storage_encrypted', 'kms_key_id'], def: 'unencrypted unless storage_encrypted = true' },
  aws_rds_cluster: { key: ['storage_encrypted', 'kms_key_id'], def: 'unencrypted unless storage_encrypted = true (Aurora Serverless v1 always encrypted)' },
  aws_dynamodb_table: { key: ['server_side_encryption'], def: 'encrypted with an AWS-owned key' },
  aws_ebs_volume: { key: ['encrypted', 'kms_key_id'], def: 'unencrypted unless account-level EBS encryption by default is on' },
  aws_efs_file_system: { key: ['encrypted', 'kms_key_id'], def: 'unencrypted unless encrypted = true' },
  aws_opensearch_domain: { key: ['encrypt_at_rest', 'node_to_node_encryption'], def: 'check: encryption at rest is required on newer engine versions only' },
  aws_elasticsearch_domain: { key: ['encrypt_at_rest', 'node_to_node_encryption'], def: 'unencrypted unless encrypt_at_rest is enabled' },
  aws_opensearchserverless_security_policy: { key: ['type'], def: 'encryption policy required by the service' },
  aws_elasticache_replication_group: { key: ['at_rest_encryption_enabled', 'transit_encryption_enabled', 'kms_key_id'], def: 'check engine defaults; transit encryption off unless set' },
  aws_elasticache_cluster: { key: ['at_rest_encryption_enabled', 'transit_encryption_enabled'], def: 'check engine defaults' },
  aws_sqs_queue: { key: ['sqs_managed_sse_enabled', 'kms_master_key_id'], def: 'SQS-managed SSE on by default for new queues' },
  aws_sns_topic: { key: ['kms_master_key_id'], def: 'not encrypted with KMS unless kms_master_key_id is set' },
  aws_cloudwatch_log_group: { key: ['kms_key_id'], def: 'encrypted by CloudWatch with a service key; no customer-managed key' },
  aws_kinesis_stream: { key: ['encryption_type', 'kms_key_id'], def: 'unencrypted unless encryption_type = KMS' },
  aws_kinesis_firehose_delivery_stream: { key: ['server_side_encryption'], def: 'check destination encryption' },
  aws_redshift_cluster: { key: ['encrypted', 'kms_key_id'], def: 'check: newer clusters encrypted by default' },
  aws_secretsmanager_secret: { key: ['kms_key_id'], def: 'encrypted with the AWS managed key aws/secretsmanager' },
  aws_ssm_parameter: { key: ['type', 'key_id'], def: 'only SecureString parameters are encrypted' },
  aws_lambda_function: { key: ['kms_key_arn'], def: 'environment variables encrypted with an AWS managed key' },
  aws_bedrockagent_knowledge_base: { key: ['kms_key_arn'], def: 'check vector store encryption separately' },
  aws_bedrock_guardrail: { key: ['kms_key_arn'], def: 'AWS-owned key' },
  google_storage_bucket: { key: ['encryption'], def: 'Google-managed encryption key' },
  google_sql_database_instance: { key: ['encryption_key_name'], def: 'Google-managed encryption key' },
  google_bigquery_dataset: { key: ['default_encryption_configuration'], def: 'Google-managed encryption key' },
  azurerm_storage_account: { key: ['customer_managed_key', 'infrastructure_encryption_enabled'], def: 'Microsoft-managed keys' },
  azurerm_cosmosdb_account: { key: ['key_vault_key_id'], def: 'Microsoft-managed keys' },
  azurerm_postgresql_flexible_server: { key: ['customer_managed_key'], def: 'Microsoft-managed keys' },
};
const AI_TYPES = /^(aws_bedrock\w*|aws_sagemaker\w*|aws_opensearchserverless\w*|google_vertex_ai\w*|azurerm_cognitive\w*|azurerm_search_service|aws_kendra\w*)$/;
const INTERESTING = /^(region|location|kms_key_id|kms_key_arn|kms_master_key_id|sse_algorithm|storage_encrypted|encrypted|encryption_type|at_rest_encryption_enabled|transit_encryption_enabled|sqs_managed_sse_enabled|publicly_accessible|acl|block_public_acls|block_public_policy|ignore_public_acls|restrict_public_buckets|authorization_type|authorization|retention_in_days|deletion_protection|backup_retention_period|multi_az|engine|engine_version|instance_class|model_id|foundation_model|cidr_blocks|from_port|to_port|enable_key_rotation|minimum_tls_version|min_tls_version|https_only|public_network_access_enabled|type|enabled|s3_bucket_name|include_global_service_events|is_multi_region_trail|text_data_delivery_enabled|log_group_name|runtime|handler|timeout|memory_size|iam_database_authentication_enabled|skip_final_snapshot|force_destroy|versioning_configuration|status|policy_arn)$/;
const SECRET_ATTR = /(password|secret|token|private_key|api_key|access_key)/i;

function blocks(text) {
  const out = [];
  const re = /^[ \t]*(resource|data|provider|module|variable|terraform)\s*(?:"([^"]+)")?\s*(?:"([^"]+)")?\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let inStr = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== '\\') inStr = !inStr;
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    out.push({ kind: m[1], type: m[2] || null, name: m[3] || null, start: m.index, body: text.slice(m.index + m[0].length, i), line: lineOf(text, m.index) });
  }
  return out;
}

function attrs(body) {
  const out = {};
  const nested = new Set();
  for (const line of body.split('\n')) {
    const a = line.match(/^\s*([a-z_][a-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (a && INTERESTING.test(a[1]) && !(a[1] in out)) out[a[1]] = SECRET_ATTR.test(a[1]) ? '[set]' : a[2].replace(/\s+#.*$/, '').slice(0, 120);
    const b = line.match(/^\s*([a-z_][a-z0-9_]*)\s*\{/);
    if (b) nested.add(b[1]);
    const s = line.match(/^\s*([a-z_]*(password|secret|token|api_key)[a-z_]*)\s*=\s*"([^"$]{4,})"/i);
    if (s) out[`hardcoded:${s[1]}`] = '[literal value in code]';
  }
  return { attrs: out, nested: [...nested] };
}

function terraform(files, repo) {
  const tfFiles = files.filter((f) => f.path.endsWith('.tf'));
  if (!tfFiles.length) return null;
  const all = [];
  const vars = {};
  const providers = [];
  const backends = [];
  for (const f of tfFiles) {
    for (const b of blocks(f.text)) {
      b.file = f;
      if (b.kind === 'variable') {
        const d = b.body.match(/^\s*default\s*=\s*"([^"]*)"/m);
        if (d) vars[b.type] = d[1];
      } else if (b.kind === 'provider') {
        const r = b.body.match(/^\s*(region|location)\s*=\s*(.+)$/m);
        const alias = b.body.match(/^\s*alias\s*=\s*"([^"]+)"/m)?.[1];
        providers.push({ provider: b.type, alias: alias || null, regionExpr: r?.[2]?.trim() || null, ...ref(f, b.line) });
      } else if (b.kind === 'terraform') {
        const be = b.body.match(/backend\s+"(\w+)"\s*\{([^}]*)\}/);
        if (be) backends.push({ type: be[1], encrypt: /encrypt\s*=\s*true/.test(be[2]), ...ref(f, b.line + lineOf(b.body, b.body.indexOf('backend')) + 1) });
      } else if (b.kind === 'resource' || b.kind === 'data') all.push(b);
    }
  }
  const resolve = (expr) => {
    if (!expr) return null;
    const v = expr.match(/^var\.(\w+)$/);
    if (v) return vars[v[1]] ? `${vars[v[1]]} (var.${v[1]} default)` : `${expr} (no default; set at apply time)`;
    return expr.replace(/^"|"$/g, '');
  };
  for (const p of providers) p.region = resolve(p.regionExpr);
  const resources = [];
  for (const b of all.filter((x) => x.kind === 'resource')) {
    const { attrs: a, nested } = attrs(b.body);
    const id = `${b.type}.${b.name}`;
    // Companion resources that point at this one (e.g. S3 encryption config).
    const companions = all.filter((o) => o !== b && o.kind === 'resource' && o.body.includes(`${id}.`)).map((o) => ({ type: o.type, name: o.name, file: o.file.path, line: o.line + 1 }));
    const spec = ENCRYPTABLE[b.type];
    let encryption = null;
    if (spec) {
      const declared = spec.key.filter((k) => k in a || nested.includes(k) || companions.some((c) => c.type === k));
      const off = ['storage_encrypted', 'encrypted', 'at_rest_encryption_enabled'].some((k) => /^false$/.test(a[k] || ''));
      encryption = { status: off ? 'disabled' : declared.length ? 'declared' : 'not-declared', declared, providerDefault: spec.def };
    }
    const exposure = [];
    if (/^true$/.test(a.publicly_accessible || '')) exposure.push('publicly_accessible = true');
    if (/public-read/.test(a.acl || '')) exposure.push(`acl = ${a.acl}`);
    if (/"NONE"/.test(a.authorization_type || a.authorization || '')) exposure.push(`authorization = NONE`);
    if (/0\.0\.0\.0\/0/.test(a.cidr_blocks || '') || /0\.0\.0\.0\/0/.test(b.body) && /ingress/.test(b.type + nested.join())) exposure.push('ingress from 0.0.0.0/0');
    if (b.type === 'aws_s3_bucket' && !companions.some((c) => c.type === 'aws_s3_bucket_public_access_block')) exposure.push('no aws_s3_bucket_public_access_block (account-level block may still apply)');
    if (/iam|policy/.test(b.type) && /Resource\s*=\s*"\*"|"Resource"\s*:\s*"\*"|resources\s*=\s*\[\s*"\*"\s*\]/.test(b.body)) exposure.push('IAM policy grants access to all resources ("*")');
    if (/"\*"/.test(b.body) && /iam|policy/.test(b.type) && /(actions?|Action)\s*=\s*\[?\s*"\*"|"Action"\s*:\s*"\*"|\w+:\*"/.test(b.body)) exposure.push('IAM policy with wildcard actions');
    const resourceRegion = a.region || a.location;
    const providerAlias = b.body.match(/^\s*provider\s*=\s*([\w.]+)/m)?.[1];
    const prov = providers.find((p) => providerAlias ? `${p.provider}.${p.alias}` === providerAlias : !p.alias && b.type.startsWith(p.provider + '_'));
    resources.push({
      tool: 'terraform', type: b.type, name: b.name, file: b.file.path, line: b.line + 1,
      region: resolve(resourceRegion) || prov?.region || null,
      encryption, exposure, ai: AI_TYPES.test(b.type) || undefined,
      attrs: a, companions: companions.length ? companions : undefined,
    });
  }
  const state = repo.allPaths.filter((p) => /\.tfstate(\.backup)?$/.test(p)).map((p) => ({ path: p, tracked: repo.tracked.has(p) }));
  const tfvars = files.filter((f) => /\.tfvars(\.json)?$/.test(f.path)).map((f) => ({ path: f.path, tracked: repo.tracked.has(f.path), names: f.lines.map((l) => l.match(/^\s*(\w+)\s*=/)?.[1]).filter(Boolean) }));
  const modules = all.length ? tfFiles.flatMap((f) => blocks(f.text).filter((b) => b.kind === 'module').map((b) => ({ name: b.type, source: b.body.match(/source\s*=\s*"([^"]+)"/)?.[1] || null, file: f.path, line: b.line + 1 }))) : [];
  return { providers: providers.map(({ snippet, ...p }) => p), backends, resources, stateFiles: state, tfvars, modules };
}

const CFN_INTERESTING = /^\s*(BucketEncryption|SSEAlgorithm|KMSMasterKeyID|StorageEncrypted|KmsKeyId|KmsMasterKeyId|Encrypted|SSESpecification|SSEEnabled|EncryptionAtRestOptions|NodeToNodeEncryptionOptions|PubliclyAccessible|PublicAccessBlockConfiguration|AuthType|AuthorizationType|Auth|RetentionInDays|DeletionProtection|AccessControl|CidrIp|ModelId|FoundationModel|Runtime)\s*:\s*(.*)$/;

function cloudformation(files) {
  const out = [];
  for (const f of files) {
    if (!/\.(ya?ml|json|template)$/.test(f.path)) continue;
    if (!/AWSTemplateFormatVersion|Transform:\s*AWS::Serverless|"Type"\s*:\s*"AWS::|^\s+Type:\s*['"]?AWS::/m.test(f.text)) continue;
    if (f.path.endsWith('.json')) {
      let j;
      try { j = JSON.parse(f.text); } catch { continue; }
      for (const [id, r] of Object.entries(j.Resources || {})) {
        const line = f.lines.findIndex((l) => l.includes(`"${id}"`));
        const props = JSON.stringify(r.Properties || {});
        out.push({ tool: 'cloudformation', type: r.Type, name: id, file: f.path, line: line + 1, region: 'set at deploy time', encryption: /Encrypt|KMS|SSE/i.test(props) ? { status: 'declared' } : { status: 'not-declared' }, exposure: /"PubliclyAccessible":true|"AuthType":"NONE"|PublicRead/.test(props) ? ['public setting in Properties'] : [] });
      }
      continue;
    }
    const resIdx = f.lines.findIndex((l) => /^Resources:\s*$/.test(l));
    if (resIdx < 0) continue;
    let indent = null;
    let cur = null;
    for (let i = resIdx + 1; i < f.lines.length; i++) {
      const l = f.lines[i];
      if (/^\S/.test(l) && l.trim()) break;
      const m = l.match(/^(\s+)([A-Za-z0-9]+):\s*$/);
      if (m && (indent === null || m[1].length === indent)) {
        indent = m[1].length;
        cur = { tool: 'cloudformation', type: null, name: m[2], file: f.path, line: i + 1, region: 'set at deploy time', attrs: {}, exposure: [] };
        out.push(cur);
        continue;
      }
      if (!cur) continue;
      const t = l.match(/^\s+Type:\s*['"]?(AWS::[\w:]+|Custom::\w+)/);
      if (t && !cur.type) cur.type = t[1];
      const a = l.match(CFN_INTERESTING);
      if (a) cur.attrs[a[1]] = a[2].slice(0, 100);
    }
    for (const r of out.filter((x) => x.file === f.path && x.attrs)) {
      const keys = Object.keys(r.attrs);
      r.encryption = /S3::Bucket|RDS::|DynamoDB::|SQS::|SNS::|Logs::LogGroup|OpenSearch|EFS::|Elasti/.test(r.type || '') ? { status: keys.some((k) => /Encrypt|KMS|Kms|SSE/.test(k)) ? 'declared' : 'not-declared' } : null;
      if (/true/i.test(r.attrs.PubliclyAccessible || '')) r.exposure.push('PubliclyAccessible: true');
      if (/NONE/.test(r.attrs.AuthType || r.attrs.AuthorizationType || '')) r.exposure.push('auth NONE');
      if (/PublicRead/.test(r.attrs.AccessControl || '')) r.exposure.push(`AccessControl: ${r.attrs.AccessControl}`);
      if (/0\.0\.0\.0\/0/.test(r.attrs.CidrIp || '')) r.exposure.push('ingress from 0.0.0.0/0');
    }
  }
  return out;
}

const CDK_NS = /^(s3|rds|dynamodb|lambda|_lambda|lambda_|kms|ec2|opensearch|opensearchservice|sqs|sns|logs|bedrock|iam|apigateway|apigw|apigatewayv2|secretsmanager|ssm|cognito|ecs|elasticache|efs|cloudtrail|sagemaker|kendra|appsync|cloudfront)$/;
const CDK_PROPS = /\b(encryption|encrypted|storageEncrypted|storage_encrypted|encryptionKey|encryption_key|kmsKey|blockPublicAccess|block_public_access|publicReadAccess|public_read_access|publiclyAccessible|publicly_accessible|authType|auth_type|FunctionUrlAuthType\.\w+|removalPolicy|removal_policy|retention|deletionProtection|deletion_protection|enforceSSL|enforce_ssl|pointInTimeRecovery|versioned)\b\s*[:=]\s*([^,\n]+)/g;

function cdk(files) {
  const isCdk = files.some((f) => f.path.endsWith('cdk.json')) || files.some((f) => /aws-cdk-lib|aws_cdk/.test(f.text) && /\.(ts|js|py)$/.test(f.path));
  if (!isCdk) return null;
  const resources = [];
  const regions = [];
  for (const f of files) {
    if (!/\.(ts|js|py)$/.test(f.path) || !/aws-cdk-lib|aws_cdk|@aws-cdk/.test(f.text)) continue;
    f.lines.forEach((line, i) => {
      const m = line.match(/new\s+(\w+)\.(\w+)\(\s*this\s*,\s*['"]([^'"]+)['"]/) || line.match(/(\w+)\.(\w+)\(\s*self\s*,\s*["']([^"']+)["']/);
      if (m && CDK_NS.test(m[1])) {
        const body = f.lines.slice(i, i + 25).join('\n');
        const props = {};
        for (const p of body.matchAll(CDK_PROPS)) if (!(p[1] in props)) props[p[1]] = p[2].trim().slice(0, 80);
        const enc = /Bucket|DatabaseInstance|DatabaseCluster|Table|Queue|Topic|LogGroup|Domain|FileSystem/.test(m[2]) ? { status: Object.keys(props).some((k) => /encrypt|kms/i.test(k)) ? 'declared' : 'not-declared' } : null;
        const exposure = [];
        if (/true/i.test(props.publicReadAccess || props.public_read_access || '')) exposure.push('publicReadAccess: true');
        if (/true/i.test(props.publiclyAccessible || props.publicly_accessible || '')) exposure.push('publiclyAccessible: true');
        if (Object.keys(props).some((k) => /FunctionUrlAuthType\.NONE/.test(k)) || /FunctionUrlAuthType\.NONE/.test(body)) exposure.push('FunctionUrlAuthType.NONE');
        resources.push({ tool: 'cdk', type: `${m[1]}.${m[2]}`, name: m[3], file: f.path, line: i + 1, region: null, encryption: enc, exposure, attrs: props });
      }
      const r = line.match(/region\s*[:=]\s*(['"][a-z0-9-]+['"]|process\.env\.\w+|os\.environ\[?.\w+)/);
      if (r) regions.push({ region: r[1].replace(/['"]/g, ''), ...ref(f, i) });
    });
  }
  return { resources, regions };
}

function amplify(files, repo) {
  const amp = files.filter((f) => /(^|\/)amplify\//.test(f.path) || /(^|\/)(amplify\.yml|amplify_outputs\.json|aws-exports\.[jt]s)$/.test(f.path));
  if (!amp.length) return null;
  const out = { generation: null, defines: [], publicAccess: [], secrets: [], regions: [], gen1Categories: [], files: amp.map((f) => f.path).slice(0, 40) };
  for (const f of amp) {
    if (/\.(ts|js)$/.test(f.path)) {
      f.lines.forEach((l, i) => {
        if (isComment(l)) return;
        const d = l.match(/\b(defineBackend|defineAuth|defineData|defineStorage|defineFunction)\(/);
        if (d) { out.generation = 'gen2'; out.defines.push({ api: d[1], ...ref(f, i) }); }
        if (/allow\.(publicApiKey|guest)\(|authorizationModes[\s\S]*apiKey|defaultAuthorizationMode:\s*['"](apiKey|iam)['"]/.test(l)) out.publicAccess.push(ref(f, i));
        const s = l.match(/\bsecret\(\s*['"]([A-Z0-9_]+)['"]/);
        if (s) out.secrets.push({ name: s[1], file: f.path, line: i + 1 });
      });
    }
    if (/amplify_outputs\.json$/.test(f.path)) { try { const j = JSON.parse(f.text); const r = j.auth?.aws_region || j.data?.aws_region || j.storage?.aws_region; if (r) out.regions.push({ region: r, file: f.path }); } catch { /* ignore */ } }
    if (/aws-exports\.[jt]s$/.test(f.path)) { const r = f.text.match(/aws_project_region['"]?\s*:\s*['"]([a-z0-9-]+)/); if (r) out.regions.push({ region: r[1], file: f.path }); }
    if (/backend-config\.json$/.test(f.path)) { out.generation = out.generation || 'gen1'; try { out.gen1Categories = Object.keys(JSON.parse(f.text)); } catch { /* ignore */ } }
    if (/team-provider-info\.json$/.test(f.path)) out.teamProviderInfo = { path: f.path, tracked: repo.tracked.has(f.path) };
  }
  return out;
}

function compose(files) {
  const out = [];
  for (const f of files) {
    if (!/(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(f.path)) continue;
    f.lines.forEach((l, i) => { const m = l.match(/^\s*image:\s*['"]?([^\s'"]+)/); if (m) out.push({ image: m[1], file: f.path, line: i + 1 }); });
  }
  return out;
}

export function scanIac(files, repo) {
  const tf = terraform(files, repo);
  const cfn = cloudformation(files);
  const cdkOut = cdk(files);
  const amp = amplify(files, repo);
  const comp = compose(files);
  const resources = [...(tf?.resources || []), ...cfn, ...(cdkOut?.resources || [])];
  const regions = new Set();
  for (const p of tf?.providers || []) if (p.region) regions.add(p.region);
  for (const r of resources) if (r.region && r.region !== 'set at deploy time') regions.add(r.region);
  for (const r of cdkOut?.regions || []) regions.add(r.region);
  for (const r of amp?.regions || []) regions.add(r.region);
  for (const f of files) {
    if (/samconfig\.toml$/.test(f.path)) { const r = f.text.match(/region\s*=\s*"([a-z0-9-]+)"/); if (r) regions.add(r[1]); }
  }
  const tools = [tf && 'terraform', cfn.length && 'cloudformation', cdkOut && 'cdk', amp && `amplify${amp.generation ? `-${amp.generation}` : ''}`, comp.length && 'docker-compose'].filter(Boolean);
  return { tools, regions: [...regions], terraform: tf ? { providers: tf.providers, backends: tf.backends, stateFiles: tf.stateFiles, tfvars: tf.tfvars, modules: tf.modules } : null, cdk: cdkOut ? { regions: cdkOut.regions } : null, amplify: amp, compose: comp, resources };
}
