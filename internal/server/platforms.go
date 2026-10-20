package server

// Presets contain public endpoint metadata only. Models come from the user's
// account or explicit model IDs; we do not import other apps' credentials.
var providerPlatforms = []M{
	{"id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com", "description": "DeepSeek 官方 API", "docsUrl": "https://api-docs.deepseek.com/", "outputLimitField": "max_tokens"},
	{"id": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1", "description": "支持 Chat Completions 的文本模型", "docsUrl": "https://developers.openai.com/api/reference/chat-completions/overview", "outputLimitField": "max_completion_tokens"},
	{"id": "zhipu", "name": "智谱 BigModel", "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "description": "智谱通用 API", "docsUrl": "https://docs.bigmodel.cn/", "outputLimitField": "max_tokens"},
	{"id": "zai-coding-cn", "name": "智谱 Coding Plan（国内）", "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4", "description": "Coding Plan 专用地址，需对应套餐密钥", "docsUrl": "https://docs.bigmodel.cn/cn/coding-plan/overview", "outputLimitField": "max_tokens"},
	{"id": "zai", "name": "Z.ai", "baseUrl": "https://api.z.ai/api/paas/v4", "description": "Z.ai 国际通用 API", "docsUrl": "https://docs.z.ai/", "outputLimitField": "max_tokens"},
	{"id": "opencode-go", "name": "OpenCode Go Chat", "baseUrl": "https://opencode.ai/inference/go/openai/v1", "modelsUrl": "https://opencode.ai/inference/go/v1/models", "description": "选择支持 Chat Completions 的模型", "docsUrl": "https://opencode.ai/v2/docs/console/go/", "outputLimitField": "max_tokens"},
	{"id": "openrouter", "name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1", "description": "OpenAI 兼容的多模型平台", "docsUrl": "https://openrouter.ai/docs/api/reference/overview", "outputLimitField": "max_tokens"},
}
