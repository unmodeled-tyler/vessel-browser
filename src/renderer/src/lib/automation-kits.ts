import type { AutomationKit } from "../../../shared/types";

export const BUNDLED_KITS: AutomationKit[] = [
  {
    id: "research-collect",
    name: "Research & Collect",
    description:
      "Browse the web to research a topic, compile key findings, and save the best sources as bookmarks.",
    category: "research",
    icon: "BookOpen",
    estimatedMinutes: 5,
    inputs: [
      {
        key: "topic",
        label: "Topic",
        type: "text",
        placeholder: "e.g. best ergonomic keyboards 2024",
        required: true,
      },
      {
        key: "question",
        label: "What do you want to know?",
        type: "textarea",
        placeholder:
          "e.g. What are the top-rated options under $200, and what makes each one stand out?",
        hint: "The more specific your question, the better the results",
        required: true,
      },
      {
        key: "folderName",
        label: "Save bookmarks to folder",
        type: "text",
        placeholder: "e.g. Keyboard Research",
        hint: "Folder will be created if it doesn't exist",
        required: true,
        defaultValue: "Research",
      },
    ],
    promptTemplate: `Research the topic "{{topic}}" to answer this question: {{question}}

Browse at least 3–5 reputable web sources. For each useful source you find:
1. Read the key information relevant to the question
2. Save the page as a bookmark in the "{{folderName}}" folder (create it if it doesn't exist)
3. Add a short note to the bookmark explaining why it's relevant

When finished, summarize the most important findings in 3–5 bullet points and list the sources saved.`,
  },
  {
    id: "price-scout",
    name: "Price Scout",
    description:
      "Search for a product across major retailers and surface the best current price.",
    category: "shopping",
    icon: "Tag",
    estimatedMinutes: 4,
    inputs: [
      {
        key: "product",
        label: "Product",
        type: "text",
        placeholder: "e.g. Sony WH-1000XM5 headphones",
        hint: "Include brand and model number for best results",
        required: true,
      },
      {
        key: "condition",
        label: "Condition",
        type: "text",
        placeholder: "new",
        hint: "e.g. new, used, refurbished",
        required: false,
        defaultValue: "new",
      },
    ],
    promptTemplate: `Find the best current price for "{{product}}" (condition: {{condition}}).

Search Google Shopping, then check at least 3–4 major retailers (Amazon, Walmart, Best Buy, Target, or whichever are most relevant for this product type).

For each retailer where you find the product:
1. Note the price and any important details (shipping cost, availability, condition)
2. Highlight the price on the page

At the end, tell me:
- Which store has the best deal and why
- A summary of all prices found
- Any caveats worth knowing (limited stock, slow shipping, marketplace sellers, etc.)`,
  },
  {
    id: "form-filler",
    name: "Form Filler",
    description:
      "Navigate to any form, fill it out with your details, and confirm before submitting.",
    category: "forms",
    icon: "ClipboardList",
    estimatedMinutes: 3,
    inputs: [
      {
        key: "url",
        label: "Form URL",
        type: "url",
        placeholder: "https://example.com/contact",
        required: true,
      },
      {
        key: "formPurpose",
        label: "What is this form for?",
        type: "text",
        placeholder: "e.g. contact inquiry, job application, newsletter signup",
        hint: "Gives the agent context for how to interpret the fields",
        required: false,
      },
      {
        key: "details",
        label: "Your details",
        type: "textarea",
        placeholder:
          "Name: Jane Smith\nEmail: jane@example.com\nMessage: I'd like to learn more about...",
        hint: "List as key: value pairs, one per line",
        required: true,
      },
    ],
    promptTemplate: `Navigate to {{url}} and fill out the form.
{{formPurpose}}

Use the following details to fill the form fields:
{{details}}

Steps:
1. Navigate to the page and dismiss any cookie banners or overlays
2. Read the form to understand what each field expects
3. Match and fill all fields you have information for — skip fields you have no data for
   - Text inputs, textareas, and <select> dropdowns: use fill_form_field or select_option
   - Checkboxes and radio buttons: use click — do NOT use select_option on these
   - For multi-checkbox groups (e.g. "select all that apply"), click each relevant option individually
4. Do NOT submit yet — show me a summary of everything you filled in and wait for my confirmation`,
  },
];

/**
 * Render a kit's prompt template by substituting {{key}} placeholders
 * with the values the user filled in.
 */
export function renderKitPrompt(
  kit: AutomationKit,
  values: Record<string, string>,
): string {
  for (const input of kit.inputs) {
    if (input.required && !values[input.key]?.trim()) {
      console.warn(
        `[automation-kits] Required field "${input.key}" is empty for kit "${kit.id}".`,
      );
    }
  }
  return kit.promptTemplate.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => values[key] ?? "",
  );
}
