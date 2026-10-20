"""Generate the implemented route inventory and core request contracts."""
import json, re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
ref = lambda name: {"$ref": "#/components/schemas/" + name}
obj = lambda properties, required=(): {"type": "object", "properties": properties, "required": list(required)}
string = {"type": "string"}
schemas = {
    "Error": obj({"code": string, "message": string, "retryable": {"type": "boolean"}, "requestId": string}, ("code", "message", "retryable", "requestId")),
    "Quote": obj({key: string for key in ["visible", "exact", "prefix", "suffix"]}, ("visible", "exact", "prefix", "suffix")),
    "Selector": {"oneOf": [obj({"type": {"const": "text"}, "block": string, "start": {"type": "integer", "minimum": 0}, "end": {"type": "integer", "minimum": 1}}, ("type", "block", "start", "end")), obj({"type": {"const": "pdf"}, "pageIndex": {"type": "integer", "minimum": 0}, "quads": {"type": "array", "items": {"type": "array", "minItems": 8, "maxItems": 8, "items": {"type": "number"}}}}, ("type", "pageIndex", "quads")), obj({"type": {"const": "epub"}, "href": string, "cfi": string}, ("type", "href", "cfi"))]},
    "SelectionSnapshot": obj({"schemaVersion": {"const": 1}, **{key: string for key in ["workspaceDocumentId", "documentVersionId", "extractionArtifactId", "normalizationVersion", "parserVersion"]}, "resourceManifestId": {"type": ["string", "null"]}, "targetKind": {"enum": ["text", "page"]}, "quote": ref("Quote"), "selectors": {"type": "array", "items": ref("Selector")}, "displayLocation": obj({"label": string, "pageIndex": {"type": "integer", "minimum": 0}})}, ("schemaVersion", "workspaceDocumentId", "documentVersionId", "extractionArtifactId", "targetKind", "quote", "selectors", "displayLocation", "normalizationVersion", "parserVersion")),
    "ContextPackage": obj({**{key: string for key in ["workspaceDocumentId", "documentVersionId", "extractionArtifactId", "normalizationVersion", "artifactHash"]}, "resourceManifestId": {"type": ["string", "null"]}, "fragments": {"type": "array", "items": obj({"blockId": string, "start": {"type": "integer"}, "end": {"type": "integer"}, "text": string, "locator": {"type": "object"}}, ("blockId", "start", "end", "text"))}}, ("workspaceDocumentId", "documentVersionId", "extractionArtifactId", "normalizationVersion", "artifactHash", "fragments")),
    "MessageInput": obj({"body": {"type": "string", "minLength": 1, "maxLength": 30000}, "recipient": {"enum": ["note", "assistant"]}, "contextPackage": ref("ContextPackage"), "modelProfileId": string, "modelId": string, "contextPolicy": {"enum": ["selection", "nearby"]}}, ("body", "recipient")),
    "CreateThread": obj({"workspaceDocumentId": string, "documentVersionId": string, "selectionSnapshot": ref("SelectionSnapshot"), "style": obj({"color": string, "underline": {"type": "boolean"}}), "message": ref("MessageInput"), "clientRequestId": string, "draftId": string}, ("workspaceDocumentId", "documentVersionId", "selectionSnapshot", "clientRequestId")),
    "AddMessage": obj({"message": ref("MessageInput"), "clientRequestId": string, "draftId": string}, ("message", "clientRequestId")),
    "Prepare": obj({"workspaceDocumentId": string, "sourceEntryId": string}, ("workspaceDocumentId", "sourceEntryId")),
    "Provider": obj({"name": string, "platformId": string, "models": {"type": "array", "maxItems": 256, "items": string}, "protocol": {"enum": ["openai", "mock"]}, "baseUrl": {"type": "string", "format": "uri"}, "modelId": string, "apiKey": {"type": "string", "writeOnly": True}, "revision": {"type": "integer"}, "inputBudget": {"type": "integer"}, "generatedTokenCap": {"type": "integer"}, "contextWindow": {"type": "integer"}, "timeout": {"type": "integer"}, "streaming": {"type": "boolean"}, "includeUsage": {"type": "boolean"}, "systemRole": {"enum": ["system", "developer", "none"]}, "outputLimitField": {"enum": ["max_tokens", "max_completion_tokens"]}}, ("name", "protocol", "baseUrl")),
    "RunEvent": obj({"runId": string, "seq": {"type": "integer"}, "type": {"enum": ["status", "text_delta", "citation", "usage", "error", "snapshot", "done"]}, "payload": {"type": "object"}}, ("runId", "seq", "type", "payload")),
}
descriptions = {
    "/api/threads": "原子保存划线、线程、首条消息和可选模型运行。相同幂等键与相同请求体返回原结果；同键不同体返回 409。",
    "/api/threads/{t}/messages": "显式 recipient=assistant 才创建问答；此时必须提供当前或已确认映射的上下文包和已启用模型。",
    "/api/requests/{k}": "按 scope 查询幂等提交结果，恢复发送响应丢失的未确认操作。读取不会触发模型。",
    "/api/backups": "一致性逻辑备份，包含未打开的导入副本，校验实际文件哈希，默认不含密钥。",
    "/api/restores/preview": "上传 ZIP 后校验路径、哈希、版本、空间；只生成预览。",
    "/api/restores/{r}/commit": "原子恢复为新工作区，全部标识重映射、凭据解绑、非终态运行中断；同一预览重复提交幂等。",
}
paths = {}
for file in (root / "internal/server").glob("*.go"):
    if file.name.endswith("_test.go"):
        continue
    for method, path in re.findall(r's\.route\("(GET|POST|PATCH|PUT|DELETE) ([^\"]+)"', file.read_text()):
        operation = {"operationId": method.lower()+re.sub(r"[^A-Za-z0-9]", "_", path), "summary": descriptions.get(path, method+" "+path), "responses": {"200": {"description": "成功", "content": {"application/json": {"schema": {}}}}, **{code: {"description": text, "content": {"application/json": {"schema": ref("Error")}}} for code, text in {"400": "参数、上下文或锚点无效", "401": "本机会话缺失", "403": "来源、工作区或发送目标不允许", "409": "revision 冲突、版本变化或任务冲突", "413": "内容或压缩包超限", "507": "存储不足，未确认保存"}.items()}}}
        params = [{"name": name, "in": "path", "required": True, "schema": string} for name in re.findall(r"\{([^}]+)\}", path)]
        if method not in ("GET",):
            if path != "/api/session":
                params.append({"name": "X-CSRF-Token", "in": "header", "required": True, "schema": string})
            schema = {"/api/threads": ref("CreateThread"), "/api/threads/{t}/messages": ref("AddMessage"), "/api/documents/{d}/prepare": ref("Prepare"), "/api/providers": ref("Provider"), "/api/providers/{p}": ref("Provider"), "/api/session": obj({"code": string}, ("code",)), "/api/workspaces/{w}/sources": obj({"path": string, "label": string, "ignore": {"type": "array", "items": string}}, ("path",))}.get(path, {"type": "object"})
            if path == "/api/providers/{p}" and method == "DELETE":
                schema = obj({"revision": {"type": "integer"}}, ("revision",))
            if path == "/api/provider-models":
                schema = obj({"id": string, "protocol": {"enum": ["openai", "mock"]}, "baseUrl": string, "apiKey": {"type": "string", "writeOnly": True}}, ("protocol", "baseUrl"))
            operation["requestBody"] = {"content": {"application/json": {"schema": schema}}}
        if method == "GET" and ("/versions/" in path or "/artifacts/" in path or "/manifests/" in path or path.endswith("/versions")):
            params.append({"name": "workspaceDocumentId", "in": "query", "required": True, "schema": string})
        if path.endswith("/documents") and method == "GET":
            params += [{"name": name, "in": "query", "schema": string} for name in ["q", "cursor", "limit"]]
        if path.endswith("/events"):
            params += [{"name": "afterSeq", "in": "query", "schema": {"type": "integer", "minimum": 0}}, {"name": "Last-Event-ID", "in": "header", "schema": string}]
            operation["responses"]["200"]["content"] = {"text/event-stream": {"schema": string, "example": 'id: 1\ndata: {"runId":"...","seq":1,"type":"status","payload":{"state":"generating"}}\n\n'}}
        if path == "/api/requests/{k}":
            params.append({"name": "scope", "in": "query", "required": True, "schema": string})
        if path.endswith("/imports") or path == "/api/restores/preview":
            field = "files" if path.endswith("/imports") else "file"
            binary = {"type": "string", "format": "binary"}
            operation["requestBody"] = {"required": True, "content": {"multipart/form-data": {"schema": obj({field: {"type": "array", "items": binary} if field == "files" else binary}, (field,))}}}
        if path.endswith("/download") or path.endswith("/content") or path.endswith("/resource"):
            operation["responses"]["200"]["content"] = {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}
        if params:
            operation["parameters"] = params
        if path in ["/api/session", "/api/health"]:
            operation["security"] = []
        paths.setdefault(path, {})[method.lower()] = operation
document = {"openapi": "3.1.0", "info": {"title": "OpenReading 本地 API", "version": "1.0.0", "description": "单人 loopback 服务。同源会话读取，写操作同时校验 CSRF。ID 是应用生成的不透明字符串；SQLite 为持久真相。"}, "servers": [{"url": "http://127.0.0.1:7318"}], "security": [{"LocalSession": []}], "paths": paths, "components": {"securitySchemes": {"LocalSession": {"type": "apiKey", "in": "cookie", "name": "openreading_session"}}, "schemas": schemas}}
(root / "docs/openapi.json").write_text(json.dumps(document, ensure_ascii=False, indent=2)+"\n")
print(f"OpenAPI: {sum(map(len, paths.values()))} implemented operations")
