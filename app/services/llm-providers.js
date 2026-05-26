/* LLM provider registry — single source of truth for the workshop's
 * brain layer. Mirrors JarJar's CharacterRecipe.intelligence.providers[]
 * (see JarJar/packages/jarjar-brain/src/character/recipe.ts) so a future
 * curator UI can serialize the user's pick into a signed recipe with
 * zero translation.
 *
 * Each entry carries:
 *   - id            stable string used in storage + wire
 *   - name          user-facing label
 *   - tagline       short description in the modal card
 *   - keyHint       placeholder + masked-preview prefix
 *   - keyRegex      defensive format check (no upstream ping)
 *   - consoleUrl    where the user gets a key
 *   - models[]      default model list shown in the brain picker
 *   - defaultModel  the cheapest/fastest model to start with
 *   - tier          "fast" | "balanced" | "deepest" — for the picker dot
 *
 * Server-side dispatch lives in lib/dexhero-brain.js. */

export const PROVIDERS = [
    {
        id: 'anthropic',
        name: 'Anthropic',
        tagline: 'Claude — Haiku, Sonnet, Opus',
        keyHint: 'sk-ant-…',
        keyRegex: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
        consoleUrl: 'https://console.anthropic.com/settings/keys',
        defaultModel: 'claude-haiku-4-5',
        models: [
            { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  tier: 'fast'     },
            { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'balanced' },
            { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7',   tier: 'deepest'  },
        ],
    },
    {
        id: 'openai',
        name: 'OpenAI',
        tagline: 'GPT — 4o, 4.1, o-series',
        keyHint: 'sk-…',
        // OpenAI keys start with sk- or sk-proj-; the variable length suffix is
        // ~40+ chars. Loose-but-non-empty check; auth surface is the real gate.
        keyRegex: /^sk-(proj-)?[A-Za-z0-9_\-]{20,}$/,
        consoleUrl: 'https://platform.openai.com/api-keys',
        defaultModel: 'gpt-4o-mini',
        models: [
            { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'fast'     },
            { id: 'gpt-4o',      label: 'GPT-4o',      tier: 'balanced' },
            { id: 'gpt-4.1',     label: 'GPT-4.1',     tier: 'deepest'  },
        ],
    },
    {
        id: 'google',
        name: 'Google',
        tagline: 'Gemini — Flash, Pro',
        keyHint: 'AIza…',
        keyRegex: /^AIza[A-Za-z0-9_\-]{30,}$/,
        consoleUrl: 'https://aistudio.google.com/app/apikey',
        // Default to a 2.x flash model — `googleSearch` grounding is
        // free on Gemini 2.x but a paid Tier 1+ feature on 1.5. Without
        // a 2.x default the search tool silently no-ops on free keys.
        // The server's resolveGeminiModel() probes Google's ListModels
        // and self-heals if a listed name is unavailable.
        defaultModel: 'gemini-2.0-flash',
        models: [
            { id: 'gemini-2.0-flash',     label: 'Gemini 2.0 Flash',       tier: 'fast'     },
            { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (exp)', tier: 'fast'     },
            { id: 'gemini-flash-latest',  label: 'Gemini Flash (latest)',  tier: 'fast'     },
            { id: 'gemini-1.5-flash',     label: 'Gemini 1.5 Flash',       tier: 'fast'     },
            { id: 'gemini-1.5-flash-8b',  label: 'Gemini 1.5 Flash 8B',    tier: 'fast'     },
            { id: 'gemini-1.5-pro',       label: 'Gemini 1.5 Pro',         tier: 'balanced' },
        ],
    },
    {
        id: 'mistral',
        name: 'Mistral',
        tagline: 'Mistral — Small, Medium, Large',
        keyHint: '32-char key',
        keyRegex: /^[A-Za-z0-9]{32,}$/,
        consoleUrl: 'https://console.mistral.ai/api-keys',
        defaultModel: 'mistral-small-latest',
        models: [
            { id: 'mistral-small-latest',  label: 'Mistral Small',  tier: 'fast'     },
            { id: 'mistral-medium-latest', label: 'Mistral Medium', tier: 'balanced' },
            { id: 'mistral-large-latest',  label: 'Mistral Large',  tier: 'deepest'  },
        ],
    },
    {
        id: 'xai',
        name: 'Grok',
        tagline: 'xAI — Grok 2, Grok 3 Mini',
        keyHint: 'xai-…',
        keyRegex: /^xai-[A-Za-z0-9_\-]{20,}$/,
        consoleUrl: 'https://console.x.ai/',
        defaultModel: 'grok-2-latest',
        models: [
            { id: 'grok-2-latest', label: 'Grok 2',     tier: 'balanced' },
            { id: 'grok-3-mini',   label: 'Grok 3 Mini', tier: 'fast'    },
        ],
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        tagline: 'DeepSeek — open-weight reasoning',
        keyHint: 'sk-…',
        keyRegex: /^sk-[A-Za-z0-9]{20,}$/,
        consoleUrl: 'https://platform.deepseek.com/api_keys',
        defaultModel: 'deepseek-chat',
        models: [
            { id: 'deepseek-chat',     label: 'DeepSeek V3',  tier: 'balanced' },
            { id: 'deepseek-reasoner', label: 'DeepSeek R1',  tier: 'deepest'  },
        ],
    },
    /* OpenRouter — the gateway provider. One key, hundreds of upstream
     * models (Claude / GPT / Gemini / Llama / Mixtral / Qwen / new
     * releases within hours). The curated short list below covers the
     * common picks; advanced users can wire any OpenRouter model name
     * by setting it via the brain-picker's free-form path (not built
     * yet — until then, swap the entry's `defaultModel`). */
    {
        id: 'openrouter',
        name: 'OpenRouter',
        tagline: 'OpenRouter — every model, one key',
        keyHint: 'sk-or-v1-…',
        keyRegex: /^sk-or-v1-[A-Za-z0-9_\-]{20,}$/,
        consoleUrl: 'https://openrouter.ai/keys',
        defaultModel: 'anthropic/claude-haiku-4-5',
        models: [
            { id: 'anthropic/claude-haiku-4-5',           label: 'Claude Haiku 4.5 (via OR)',     tier: 'fast'     },
            { id: 'anthropic/claude-sonnet-4-6',          label: 'Claude Sonnet 4.6 (via OR)',    tier: 'balanced' },
            { id: 'anthropic/claude-opus-4-7',            label: 'Claude Opus 4.7 (via OR)',      tier: 'deepest'  },
            { id: 'openai/gpt-4o-mini',                   label: 'GPT-4o mini (via OR)',          tier: 'fast'     },
            { id: 'openai/gpt-4o',                        label: 'GPT-4o (via OR)',               tier: 'balanced' },
            { id: 'google/gemini-2.0-flash',              label: 'Gemini 2.0 Flash (via OR)',     tier: 'fast'     },
            { id: 'meta-llama/llama-3.3-70b-instruct',    label: 'Llama 3.3 70B (via OR)',        tier: 'balanced' },
            { id: 'deepseek/deepseek-chat',               label: 'DeepSeek V3 (via OR)',          tier: 'balanced' },
            { id: 'deepseek/deepseek-r1',                 label: 'DeepSeek R1 (via OR)',          tier: 'deepest'  },
            { id: 'qwen/qwen-2.5-72b-instruct',           label: 'Qwen 2.5 72B (via OR)',         tier: 'balanced' },
        ],
    },
    /* Groq — fast inference of open models with a generous free tier.
     * Different from xAI's "Grok" (the chatbot product) — Groq is the
     * inference infrastructure company. Free tier alone is plenty for
     * a personal DexHero. */
    {
        id: 'groq',
        name: 'Groq',
        tagline: 'Groq — fastest inference, free tier',
        keyHint: 'gsk_…',
        keyRegex: /^gsk_[A-Za-z0-9]{20,}$/,
        consoleUrl: 'https://console.groq.com/keys',
        defaultModel: 'llama-3.1-8b-instant',
        models: [
            { id: 'llama-3.1-8b-instant',     label: 'Llama 3.1 8B (instant)',   tier: 'fast'     },
            { id: 'llama-3.3-70b-versatile',  label: 'Llama 3.3 70B (versatile)', tier: 'balanced' },
            { id: 'mixtral-8x7b-32768',       label: 'Mixtral 8×7B (32k ctx)',   tier: 'balanced' },
            { id: 'gemma2-9b-it',             label: 'Gemma2 9B',                tier: 'fast'     },
        ],
    },
    /* Local Model — Ollama / LM Studio / vLLM / any OpenAI-compatible
     * endpoint. The "key" slot stores a base URL instead of an API
     * token; the vault doesn't care, it just encrypts a string. Picking
     * a model = 'auto' makes lib/dexhero-brain.js query /v1/models on
     * first call and use whatever the local server reports. Maps
     * cleanly to JarJar's RecipeProvider.kind = 'openai_compatible'. */
    {
        id: 'local',
        name: 'Local Model',
        tagline: 'Ollama / LM Studio / vLLM — $0 + private',
        keyHint: 'http://localhost:11434/v1',
        keyRegex: /^https?:\/\/[^\s]+/,
        consoleUrl: null,
        defaultModel: 'auto',
        tier: 'local',
        privacy: 'on_device',
        endpoints: [
            { label: 'Ollama',    url: 'http://localhost:11434/v1' },
            { label: 'LM Studio', url: 'http://localhost:1234/v1'  },
            { label: 'vLLM',      url: 'http://localhost:8000/v1'  },
            { label: 'Custom',    url: ''                          },
        ],
        models: [
            { id: 'auto', label: 'Auto (detect from /v1/models)', tier: 'fast' },
        ],
    },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function getProvider(id) {
    return PROVIDERS.find((p) => p.id === id) || null;
}
