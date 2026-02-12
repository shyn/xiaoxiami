import { readFile } from "node:fs/promises";
import { getModel } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ApiFormat = "anthropic-messages" | "openai-completions";

export interface ModelConfig {
  key: string;
  label: string;
  provider: string;
  id: string;
  baseUrl?: string;
  apiFormat?: ApiFormat;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
}

export interface ModelsConfig {
  defaultModel: string;
  models: ModelConfig[];
}

function resolveApiKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("env:")) {
    const varName = raw.slice(4);
    return process.env[varName] ?? undefined;
  }
  return raw;
}

function validateModel(m: ModelConfig): ModelConfig {
  if (!m.key || typeof m.key !== "string" || m.key.length > 32) {
    throw new Error(`Invalid model key: "${m.key}" (must be 1-32 chars)`);
  }
  if (!m.label || !m.provider || !m.id) {
    throw new Error(`Model "${m.key}" missing required fields (label, provider, id)`);
  }
  return {
    ...m,
    apiKey: resolveApiKey(m.apiKey),
  };
}

export class ModelRegistry {
  readonly models: ModelConfig[];
  readonly defaultKey: string;

  constructor(config: ModelsConfig) {
    if (!config.models.length) {
      throw new Error("ModelsConfig must contain at least one model");
    }
    this.models = config.models;
    this.defaultKey = config.defaultModel;
    if (!this.get(this.defaultKey)) {
      throw new Error(`Default model key "${this.defaultKey}" not found in models`);
    }
  }

  get(key: string): ModelConfig | undefined {
    return this.models.find((m) => m.key === key);
  }

  getDefault(): ModelConfig {
    return this.get(this.defaultKey)!;
  }

  list(): ModelConfig[] {
    return this.models;
  }

  keys(): string[] {
    return this.models.map((m) => m.key);
  }
}

export class ModelStore {
  private sdkModelCache: Map<string, Model<Api>> = new Map();
  private readonly _registry: ModelRegistry;
  private readonly authStorage: AuthStorage;

  constructor(registry: ModelRegistry, authStorage: AuthStorage) {
    this._registry = registry;
    this.authStorage = authStorage;
  }

  get registry(): ModelRegistry {
    return this._registry;
  }

  getSdkModel(key: string): Model<Api> {
    const cached = this.sdkModelCache.get(key);
    if (cached) return cached;

    const config = this._registry.get(key);
    if (!config) {
      throw new Error(`Model key "${key}" not found in registry`);
    }

    const reasoning = (config.thinkingLevel ?? "off") !== "off";
    const defaultInput: ("text" | "image")[] = ["text", "image"];
    const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const builtin = getModel(config.provider as any, config.id as any) as Model<Api> | undefined;

    let model: Model<Api>;
    if (builtin) {
      model = {
        ...builtin,
        id: config.id,
        name: config.label,
        provider: config.provider,
        reasoning,
        ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
        ...(config.contextWindow !== undefined && { contextWindow: config.contextWindow }),
        ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
        ...(config.apiFormat !== undefined && { api: config.apiFormat as Api }),
      };
    } else {
      if (!config.apiFormat) {
        throw new Error(`Model "${key}" is not a known built-in and requires apiFormat to be set`);
      }
      model = {
        id: config.id,
        name: config.label,
        api: config.apiFormat as Api,
        provider: config.provider,
        baseUrl: config.baseUrl ?? "",
        reasoning,
        input: defaultInput,
        cost: defaultCost,
        contextWindow: config.contextWindow ?? 200000,
        maxTokens: config.maxTokens ?? 64000,
      };
    }

    this.sdkModelCache.set(key, model);
    return model;
  }

  getDefaultSdkModel(): Model<Api> {
    return this.getSdkModel(this._registry.defaultKey);
  }

  registerApiKeys(): void {
    const seen = new Map<string, string>();
    for (const config of this._registry.list()) {
      if (!config.apiKey) continue;
      const existing = seen.get(config.provider);
      if (existing) {
        if (existing !== config.apiKey) {
          console.error(
            `Warning: conflicting API keys for provider "${config.provider}" — using the first one found`,
          );
        }
        continue;
      }
      seen.set(config.provider, config.apiKey);
      this.authStorage.setRuntimeApiKey(config.provider, config.apiKey);
    }
  }

  clearCache(): void {
    this.sdkModelCache.clear();
  }
}

export async function loadModels(dataDir: string): Promise<ModelRegistry> {
  const filePath = `${dataDir}/models.json`;
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: ModelsConfig = JSON.parse(raw);
    if (!Array.isArray(parsed.models) || !parsed.defaultModel) {
      throw new Error("models.json must have 'defaultModel' and 'models' array");
    }
    const validated: ModelsConfig = {
      defaultModel: parsed.defaultModel,
      models: parsed.models.map(validateModel),
    };
    return new ModelRegistry(validated);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      throw new Error(`models.json not found at ${filePath}. Create it from models.json.example.`);
    }
    throw err;
  }
}
