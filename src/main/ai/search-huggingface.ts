export type HuggingFaceSection = "models" | "datasets" | "spaces";

export type SearchShortcut = {
  url: string;
  source: string;
  section?: HuggingFaceSection;
  appliedFilters: string[];
};

const HUGGING_FACE_HUB_HOSTS = new Set(["huggingface.co", "www.huggingface.co"]);

const HUGGING_FACE_MODEL_TASKS: Array<{
  value: string;
  label: string;
  phrases: string[];
}> = [
  {
    value: "automatic-speech-recognition",
    label: "automatic speech recognition",
    phrases: ["automatic speech recognition", "speech recognition", "asr"],
  },
  {
    value: "text-classification",
    label: "text classification",
    phrases: ["text classification", "classification"],
  },
  {
    value: "token-classification",
    label: "token classification",
    phrases: ["token classification", "named entity recognition", "ner"],
  },
  {
    value: "question-answering",
    label: "question answering",
    phrases: ["question answering", "qa"],
  },
  {
    value: "sentence-similarity",
    label: "sentence similarity",
    phrases: ["sentence similarity", "semantic similarity"],
  },
  {
    value: "feature-extraction",
    label: "feature extraction",
    phrases: ["feature extraction", "embeddings", "embedding"],
  },
  {
    value: "image-classification",
    label: "image classification",
    phrases: ["image classification"],
  },
  {
    value: "object-detection",
    label: "object detection",
    phrases: ["object detection"],
  },
  {
    value: "image-to-text",
    label: "image to text",
    phrases: ["image to text", "image-to-text", "ocr"],
  },
  {
    value: "text-to-image",
    label: "text to image",
    phrases: ["text to image", "text-to-image"],
  },
  {
    value: "text-to-speech",
    label: "text to speech",
    phrases: ["text to speech", "text-to-speech", "tts"],
  },
  {
    value: "text-generation",
    label: "text generation",
    phrases: [
      "text generation",
      "text-generation",
      "llm",
      "chat model",
      "chat models",
      "instruct model",
      "instruct models",
    ],
  },
  {
    value: "text2text-generation",
    label: "text2text generation",
    phrases: [
      "text2text generation",
      "text-to-text generation",
      "text to text generation",
    ],
  },
  {
    value: "summarization",
    label: "summarization",
    phrases: ["summarization", "summarize", "summarizer"],
  },
  {
    value: "translation",
    label: "translation",
    phrases: ["translation", "translate", "translator"],
  },
];

const HUGGING_FACE_MODEL_LIBRARIES: Array<{
  value: string;
  label: string;
  phrases: string[];
}> = [
  { value: "sentence-transformers", label: "sentence-transformers", phrases: ["sentence-transformers"] },
  { value: "transformers.js", label: "transformers.js", phrases: ["transformers.js"] },
  { value: "transformers", label: "transformers", phrases: ["transformers"] },
  { value: "diffusers", label: "diffusers", phrases: ["diffusers"] },
  { value: "safetensors", label: "safetensors", phrases: ["safetensors"] },
  { value: "pytorch", label: "pytorch", phrases: ["pytorch"] },
  { value: "tf", label: "tensorflow", phrases: ["tensorflow", "tf"] },
  { value: "jax", label: "jax", phrases: ["jax"] },
  { value: "onnx", label: "onnx", phrases: ["onnx"] },
  { value: "gguf", label: "gguf", phrases: ["gguf"] },
  { value: "mlx", label: "mlx", phrases: ["mlx"] },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSearchPhrase(query: string, phrase: string): string {
  return query.replace(
    new RegExp(`(^|[^\\w])${escapeRegex(phrase)}(?=[^\\w]|$)`, "gi"),
    " ",
  );
}

function collapseSearchTerms(query: string): string {
  return query
    .replace(/\b(on|in|for|with|without|from|by|to|of|the|a|an|and|or)\b/gi, " ")
    .replace(/\b(find|show|search|browse|look(?:ing)?(?:\s+for)?|need|want)\b/gi, " ")
    .replace(/\bhugging\s*face\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstMatchingFilter(
  query: string,
  filters: Array<{ value: string; label: string; phrases: string[] }>,
): { match: { value: string; label: string } | null; remainingQuery: string } {
  for (const filter of filters) {
    for (const phrase of filter.phrases) {
      const pattern = new RegExp(
        `(^|[^\\w])${escapeRegex(phrase)}(?=[^\\w]|$)`,
        "i",
      );
      if (!pattern.test(query)) continue;
      return {
        match: { value: filter.value, label: filter.label },
        remainingQuery: stripSearchPhrase(query, phrase),
      };
    }
  }

  return { match: null, remainingQuery: query };
}

function mapHuggingFaceParameterBucket(query: string): {
  value: string | null;
  label: string | null;
  remainingQuery: string;
} {
  const match = query.match(/\b(\d+(?:\.\d+)?)\s*(b|bn|billion|t|tn|trillion)\b/i);
  if (!match) {
    return { value: null, label: null, remainingQuery: query };
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { value: null, label: null, remainingQuery: query };
  }

  const unit = match[2].toLowerCase();
  const billions =
    unit === "t" || unit === "tn" || unit === "trillion" ? amount * 1000 : amount;

  let value: string;
  if (billions < 1) value = "n<1B";
  else if (billions < 3) value = "1B<n<3B";
  else if (billions < 6) value = "3B<n<6B";
  else if (billions < 9) value = "6B<n<9B";
  else if (billions < 12) value = "9B<n<12B";
  else if (billions < 24) value = "12B<n<24B";
  else if (billions < 32) value = "24B<n<32B";
  else if (billions < 64) value = "32B<n<64B";
  else if (billions < 128) value = "64B<n<128B";
  else if (billions < 256) value = "128B<n<256B";
  else if (billions < 500) value = "256B<n<500B";
  else if (billions < 1000) value = "500B<n<1T";
  else value = "n>1T";

  return {
    value,
    label: `${amount}${unit.startsWith("t") ? "T" : "B"} size bucket`,
    remainingQuery: query.replace(match[0], " "),
  };
}

function chooseHuggingFaceSection(
  url: URL,
  query: string,
): HuggingFaceSection | null {
  const pathname = url.pathname.toLowerCase();
  const normalized = query.toLowerCase();

  const mentionsDatasets = /\b(dataset|datasets|corpus|benchmark|benchmarks)\b/.test(
    normalized,
  );
  const mentionsSpaces = /\b(space|spaces|app|apps|demo|demos|gradio|streamlit)\b/.test(
    normalized,
  );
  const mentionsModels = /\b(model|models|checkpoint|checkpoints|lora|loras|weights)\b/.test(
    normalized,
  );

  if (mentionsDatasets && !mentionsModels && !mentionsSpaces) return "datasets";
  if (mentionsSpaces && !mentionsModels && !mentionsDatasets) return "spaces";
  if (mentionsModels && !mentionsDatasets && !mentionsSpaces) return "models";

  if (pathname.startsWith("/models")) return "models";
  if (pathname.startsWith("/datasets")) return "datasets";
  if (pathname.startsWith("/spaces")) return "spaces";

  if (
    HUGGING_FACE_MODEL_TASKS.some((entry) =>
      entry.phrases.some((phrase) =>
        new RegExp(`(^|[^\\w])${escapeRegex(phrase)}(?=[^\\w]|$)`, "i").test(
          normalized,
        ),
      ),
    ) ||
    HUGGING_FACE_MODEL_LIBRARIES.some((entry) =>
      entry.phrases.some((phrase) =>
        new RegExp(`(^|[^\\w])${escapeRegex(phrase)}(?=[^\\w]|$)`, "i").test(
          normalized,
        ),
      ),
    ) ||
    /\b\d+(?:\.\d+)?\s*(b|bn|billion|t|tn|trillion)\b/i.test(normalized)
  ) {
    return "models";
  }

  return null;
}

export function buildHuggingFaceSearchShortcut(
  currentUrl: string,
  rawQuery: string,
): SearchShortcut | null {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (!HUGGING_FACE_HUB_HOSTS.has(hostname)) {
    return null;
  }

  const query = rawQuery.trim();
  if (!query) return null;

  const section = chooseHuggingFaceSection(url, query);
  if (!section) return null;

  let remainingQuery = query;
  const target = new URL(`https://huggingface.co/${section}`);
  const appliedFilters: string[] = [];

  if (section === "models") {
    const taskResult = extractFirstMatchingFilter(
      remainingQuery,
      HUGGING_FACE_MODEL_TASKS,
    );
    remainingQuery = taskResult.remainingQuery;
    if (taskResult.match) {
      target.searchParams.append("pipeline_tag", taskResult.match.value);
      appliedFilters.push(`task: ${taskResult.match.label}`);
    }

    const libraryResult = extractFirstMatchingFilter(
      remainingQuery,
      HUGGING_FACE_MODEL_LIBRARIES,
    );
    remainingQuery = libraryResult.remainingQuery;
    if (libraryResult.match) {
      target.searchParams.append("library", libraryResult.match.value);
      appliedFilters.push(`library: ${libraryResult.match.label}`);
    }

    const parameterResult = mapHuggingFaceParameterBucket(remainingQuery);
    remainingQuery = parameterResult.remainingQuery;
    if (parameterResult.value && parameterResult.label) {
      target.searchParams.append("num_parameters", parameterResult.value);
      appliedFilters.push(parameterResult.label);
    }
  }

  remainingQuery = collapseSearchTerms(
    remainingQuery
      .replace(/\bmodels?\b/gi, " ")
      .replace(/\bdatasets?\b/gi, " ")
      .replace(/\bspaces?\b/gi, " ")
      .replace(/\bapps?\b/gi, " "),
  );

  if (remainingQuery) {
    target.searchParams.set("search", remainingQuery);
  }

  if (!remainingQuery && appliedFilters.length === 0) {
    return null;
  }

  if (section === "spaces" && remainingQuery) {
    target.searchParams.set("includeNonRunning", "true");
  }

  return {
    url: target.toString(),
    source: "Hugging Face",
    section,
    appliedFilters,
  };
}
