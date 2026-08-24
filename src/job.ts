import { parseArgs } from "node:util";

export interface GenerationOptions {
  style?: string;
  model?: string;
  instrumental: boolean;
}

export interface SunoJob {
  prompt: string;
  options: GenerationOptions;
}

const scalarOptions = new Set(["prompt", "style", "model"]);

export function parseSunoJob(args: readonly string[]): SunoJob {
  const { values, tokens } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: {
      prompt: { type: "string" },
      style: { type: "string" },
      model: { type: "string" },
      instrumental: { type: "boolean", default: false },
    },
  });

  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || !scalarOptions.has(token.name)) continue;
    if (seen.has(token.name)) throw new Error(`Option --${token.name} may only be provided once.`);
    seen.add(token.name);
  }

  const prompt = requiredText(values.prompt, "prompt");
  const style = optionalText(values.style, "style");
  const model = optionalText(values.model, "model");

  return {
    prompt,
    options: {
      ...(style === undefined ? {} : { style }),
      ...(model === undefined ? {} : { model }),
      instrumental: values.instrumental ?? false,
    },
  };
}

function requiredText(value: string | undefined, name: string): string {
  const text = optionalText(value, name);
  if (text === undefined) throw new Error(`Option --${name} is required.`);
  return text;
}

function optionalText(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) throw new Error(`Option --${name} must not be blank.`);
  return text;
}
